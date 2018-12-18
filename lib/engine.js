'use strict';

import events       from 'events';
import axios        from 'axios';
import webrtc       from 'webrtc-adapter'; // eslint-disable-line no-unused-vars
import jwtDecode    from 'jwt-decode';     // eslint-disable-line no-unused-vars
import Logger       from './Logger';
import sdpTransform from 'sdp-transform'; // eslint-disable-line no-unused-vars 

import SignalingClient from './signaling';


import RTCStream   from './stream';
import DeviceManager from './device';


const logger = new Logger('RTCEngine');

class RTCEngine extends events.EventEmitter
{
    constructor()
    {
        super();
        this.setMaxListeners(Infinity);

        this._localStreams = new Map();
        this._remoteStreams = new Map();
        this._state = RTCEngine.NEW;
        this._peers = new Map();  //  {userid:{id:userid,msids:[]}}
        this._signaling = null;
        this._auth = null;
        this._iceServers = null;
        this._iceTransportPolicy = null;
        this._peerconnection = null;
        this._iceConnected = false;
        this._iceCandidatePoolSize = 1;
    }

    getState () 
    {
        return this._state;
    }

    getLocalStreams()
    {
        return Array.from(this._localStreams.values())
    }

    getRemoteStreams()
    {
        return Array.from(this._remoteStreams.values())
    }
    
    async addStream(stream)
    {
        if(this._state !== RTCEngine.CONNECTED){
            throw new Error('must addStream after join room')
        }

        if(!stream instanceof RTCStream)  {
            throw new Error('stream must be RTCStream')
        }

        // we should start local medis before we start 
        stream._engine = this;

        if(this._localStreams.get(stream.streamId)){
            return;
        }

        stream._peerconnection = this._peerconnection;


        if(stream._audioTrack) {
            stream._audioSender = await this._peerconnection.addTrack(stream._audioTrack,stream._stream)
            await this._addTrack(stream._audioTrack, stream._stream)
        }

        if(stream._videoTrack) {
            stream._videoSender = await this._peerconnection.addTrack(stream._videoTrack,stream._stream)
            await this._addTrack(stream._videoTrack, stream._stream)
        }

        this._localStreams.set(stream.streamId,stream);

        stream._peerId = this._auth.user;

        stream.on('close', async () => {

            if(this._localStreams.get(stream.streamId)){
                this._localStreams.delete(stream.streamId);
    
                if(stream._audioSender) {
                    this._peerconnection.removeTrack(stream._audioSender)
                }
                
                if(stream._videoSender) {
                    this._peerconnection.removeTrack(stream._videoSender)
                }
    
                this._removeStream(stream);

                this.emit('removeLocalStream',stream);
            }
        })
    }

    joinRoom(token)
    {
        if(this._state === RTCEngine.CONNECTED){
            logger.error("RTCEngine has connected");
            return;
        }
        try {
            this._auth = jwtDecode(token);
        } catch (error) {
            logger.error('error')
            this.emit('error', error)
            return;
        }
        this._auth.token = token; 

        // iceservers
        this._iceServers = this._auth.iceServers;

        // iceTransportPolicy
        this._iceTransportPolicy = this._auth.iceTransportPolicy;

        this._setupSignalingClient();
    }
    leaveRoom()
    {
        if(this._state === RTCEngine.DISCONNECTED){
            logger.error("leaveRoom state already is DISCONNECTED");
            return;
        }
        this._sendLeave();

        this._close();
    }
    generateTestToken(tokenUrl,appkey,room,user,callback)
    { 
        axios.post(tokenUrl,{
            appkey:appkey,
            room:room,
            user:user
        })
        .then((response) => {
            if(response.status >= 400){
                callback(response.statusText,null);
                return;
            }
            if(response.data.s > 10000){
                callback(response.data.e,null);
                return;
            }
            callback(null,response.data.d.token);
        })
        .catch((error) => {
            logger.error('generateTestToken error ', error);
            callback(error, null);
        });
    }
    
    _close()
    {
        if(this._state === RTCEngine.DISCONNECTED){
            return;
        }

        this._setState(RTCEngine.DISCONNECTED);

        if(this._signaling){
            this._signaling.close();
        }

        for(let stream of this._localStreams){
            if(stream._audioSender) {
                this._peerconnection.removeTrack(stream._audioSender)
            }
            
            if(stream._videoSender) {
                this._peerconnection.removeTrack(stream._videoSender)
            }
        }

        for(let stream of this._remoteStreams.values()){
            stream._close();
            this.emit('removeRemoteStream', stream);
        }
        this._remoteStreams.clear();

        if (this._peerconnection) {
            this._peerconnection.close();
        }
    }
    _setState(state)
    {
        if(this._state === state){
            return;
        }
        this._state = state;
        this.emit('state', this._state);
    }
    _createPeerConnection()
    {
        let options = {
                iceServers: this._iceServers || [],
                iceTransportPolicy :  this._iceTransportPolicy || 'all',   // relay or all
                iceCandidatePoolSize: this._iceCandidatePoolSize,
                bundlePolicy       : 'max-bundle',
                rtcpMuxPolicy      : 'require',
                sdpSemantics       : 'unified-plan'   
        };  // eslint-disable-line no-unused-vars 

        this._peerconnection = new RTCPeerConnection(options);


        this._peerconnection.oniceconnectionstatechange = () => 
        {

            switch(this._peerconnection.iceConnectionState)
            {
                case 'new':
                case 'checking':
                    break;
                case 'connected':
                case 'completed':
                    this._iceConnected = true; // we should check 
                    break;
                case 'failed':
                case 'disconnected':
                case 'closed':
                    this._iceConnected = false;
                    break;
                default: 
                    logger.error('can not match state');
                
            }

            logger.debug('iceConnectionState', this._peerconnection.iceConnectionState);
        };


        this._peerconnection.ontrack = (event) => {

            const stream = event.stream;

            if (this._remoteStreams.get(stream.id)) {
                return;
            }

            let peer = this._peerForStream(stream.id);

            if(!peer){
                logger.error('can not find peer for stream ', stream.id);
                return; 
            }

            let options = {
                stream:stream,
                local:false,
                audio:!!stream.getAudioTracks().length,
                video:!!stream.getVideoTracks().length,
                peerId:peer.id,
                engine:this
            };

            let remoteStream = new RTCStream(options);

            this._remoteStreams.set(stream.id, remoteStream);

            // map attributes 
            for (let streamData of peer.streams) {
                if (streamData.id === stream.id) {
                    remoteStream._setAttributes(streamData.attributes)
                }
            }

            this.emit('addRemoteStream', remoteStream);
        }

        this._peerconnection.onnegotiationneeded = () => {

            logger.debug('onnegotiationneeded')
        }

        this._peerconnection.onremovestream = (event) => {


            logger.error("onremovestream ==================")

            const stream = event.stream;

            let peer = this._peerForStream(stream.id);

            if(!peer){
                logger.error('can not find peer for stream ', stream.id);
            }

            let remoteStream = this._remoteStreams.get(stream.id);

            if(!remoteStream){
                return;
            }

            this.emit('removeRemoteStream', remoteStream);

            this._remoteStreams.delete(remoteStream.streamId)
        };

        this._peerconnection.onicecandidate = (event) => {

            logger.debug('onicecandidate', event.candidate);
        };
    }

    async _removeTrack(track, stream)
    {

        const offer = await this._peerconnection.createOffer();
        await this._peerconnection.setLocalDescription(offer);

        const sdp = await this._signaling.request('removetrack', {
            sdp: offer.sdp,
            track : {
                streamId: stream.id,
                trackId: track.id,
                bitrate: 500,
                attributes: {}
            }
        })

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: sdp
        });

        console.error(answer);

        await this._peerconnection.setRemoteDescription(answer)
    }

    async _addTrack(track, stream) 
    {
        console.log('track ==========', track.id)
        console.log('stream =========', stream.id)

        const offer = await this._peerconnection.createOffer();
        await this._peerconnection.setLocalDescription(offer);

        const sdp = await this._signaling.request('addtrack', {
            sdp: offer.sdp,
            track : {
                streamId: stream.id,
                trackId: track.id,
                bitrate: 500,
                attributes: {}
            }
        })

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: sdp
        });

        console.error(answer);

        await this._peerconnection.setRemoteDescription(answer)

    }

    _setupSignalingClient()
    {
        
        this._signaling = new SignalingClient(this._auth.wsUrl, this._auth.token)

        this._signaling.on('connect', async() => {
            await this._join();
        })

        this._signaling.on('close',() => {
            this._close();
        })

        this._signaling.on('offer', async (data) => {
            this._handleOffer(data);
        })

        this._signaling.on('peerRemoved', async (data) => {
            this._handlePeerRemoved(data);
        })

        this._signaling.on('peerConnected', (data) => {
            this._handlePeerConnected(data);
        })

        this._signaling.on('configure', (data) => {
            this._handleConfigure(data);
        })

        this._signaling.on('message', (data) => {
            this.emit('message', data)
         })

    }

    async _handleJoined(data)
    {
        let peers = data.room.peers;
        
        peers.forEach((peer) => {
            this._peers.set(peer.peerId, peer);
        });

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: data.sdp
        });

        await this._peerconnection.setRemoteDescription(answer)

        this._setState(RTCEngine.CONNECTED);

    }
    _handleOffer(data)
    {

        let peers = data.room.peers;

        peers.forEach((peer) => {
            this._peers.set(peer.id, peer);
        });

        let offer = new RTCSessionDescription({
            sdp: data.sdp,
            type: 'offer'
        });

        Promise.resolve()
            .then(() => {
                return this._peerconnection.setRemoteDescription(offer);
            })
            .then(() => {

                if (this._peerconnection.signalingState === 'stable'){
                    return this._peerconnection.localDescription;
                }
                return this._peerconnection.createAnswer();
            })
            .then((answer) => {
                return this._peerconnection.setLocalDescription(answer);
            })
            .catch((error) => {
                logger.error('_handleOffer error ', error);
            });
    }
    _handleAnswer(data)
    {
        let peers = data.room.peers;
        
        peers.forEach((peer) => {
            this._peers.set(peer.peerId, peer);
        });

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: data.sdp
        });

        this._peerconnection.setRemoteDescription(answer)
            .catch((error) => {
                logger.error('setRemoteDescription error ', error);
            });
    }
    _handlePeerRemoved(data)
    {
        let peer = data.peer;
        // we do not remove peer here
        this.emit('peerRemoved', peer.id);
    }
    _handlePeerConnected(data)
    {
        let peer = data.peer;
        this._peers.set(peer.peerId,peer);

        this.emit('peerConnected', peer.peerId);
    }
    _handleConfigure(data)
    {

        let msid = data.msid;
        
        let remoteStream = this._remoteStreams.get(msid);
        
        if(!remoteStream){
            return;
        }

        if('video' in data){
            let muting = data.muting;
            remoteStream._onVideoMuting(muting);
            this.emit('muteRemoteVideo',remoteStream,muting);
            return;
        }

        if('audio' in data){
            let muting = !data.muting;
            remoteStream._onAudioMuting(muting);
            this.emit('muteRemoteAudio',remoteStream,muting);
            return;
        }
    }
    _handleAttributes(data)
    {
        let msid = data.msid 
        let attributes = data.attributes 

        this._msAttributes.set(msid,attributes)

        let remoteStream = this._remoteStreams.get(msid)
        if(!remoteStream){
            return;
        }
        remoteStream._setAttributes(attributes)
    }
    _handleError(data)
    {
        logger.debug('handleError ', data);
    }
    async _join()
    {
        let planb =  true;
        if(DeviceManager.flag === 'firefox'){
            planb = false;
        } else {
            logger.debug('browser ', DeviceManager.flag, ' is not firefox, planb  ', planb);
        }

        // init pc first
        this._createPeerConnection();

        this._peerconnection.addTransceiver("audio",{direction:"inactive"});
		this._peerconnection.addTransceiver("video",{direction:"inactive"});

        const offer = await this._peerconnection.createOffer()
        await this._peerconnection.setLocalDescription(offer)

        const data = {
            appkey:this._auth.appkey,
            room:this._auth.room,
            user:this._auth.user,
            token:this._auth.token,
            planb:planb,
            sdp: offer.sdp
        }

        let joined = await this._signaling.request('join', data)

        await this._handleJoined(joined)

    }
    _sendLeave()
    {
        this._socket.emit('leave', {})
    }
    _sendConfigure(data)
    {
        this._socket.emit('configure', data);
    }
    _peerForStream(streamId)
    {
        let findPeer;
        for(let peer of this._peers.values()){
            let msids = peer.tracks.map((s) => { return s.streamId })
            let msidSet = new Set(msids);
            if(msidSet.has(streamId)){
                findPeer = peer
                break;
            }
        }
        return findPeer; 
    }
    _getLocalStreamById(streamId)
    {
        let stream; 
        this._localStreams.forEach((value) => {
            if(value.streamId === streamId){
                stream = value;
            }
        });
        return stream;
    }
}

RTCEngine.NEW = 'new';
RTCEngine.CONNECTING = 'connecting';
RTCEngine.CONNECTED = 'connected';
RTCEngine.DISCONNECTED = 'disconnected';
RTCEngine.CLOSED = 'closed';

export {
    RTCEngine
}



