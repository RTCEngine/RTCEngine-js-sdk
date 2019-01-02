'use strict';

import events       from 'events';
import webrtc       from 'webrtc-adapter'; // eslint-disable-line no-unused-vars
import jwtDecode    from 'jwt-decode';     // eslint-disable-line no-unused-vars
import Logger       from './Logger';
import sdpTransform from 'sdp-transform'; // eslint-disable-line no-unused-vars 

import io           from 'socket.io-client';

import TransactionManager from 'socketio-transaction';
import ExecutingQueue from './queue';
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
        this._peers = new Map();  //  {peerId:{peerId:str,streams:[]}}
        this._signaling = null;
        this._auth = null;
        this._iceServers = null;
        this._iceTransportPolicy = null;
        this._peerconnection = null;
        this._iceConnected = false;
        this._iceCandidatePoolSize = 1;

        this._socket = null;
        this._tm = null;

        this._queue = new ExecutingQueue();
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

    async publish(stream)
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
        this._localStreams.set(stream.streamId,stream);
        stream._peerId = this._auth.user;

        if(stream._audioTrack) {
            stream._audioSender = await this._peerconnection.addTrack(stream._audioTrack,stream._stream)
        }

        if(stream._videoTrack) {
            stream._videoSender = await this._peerconnection.addTrack(stream._videoTrack,stream._stream)
        }

        this._queue.push(async() => {
            await this._publish(stream)
        })
    }

    async unpublish(stream) 
    {

        if(this._localStreams.get(stream.streamId)){
            this._localStreams.delete(stream.streamId);
            if(stream._audioSender) {
                this._peerconnection.removeTrack(stream._audioSender)
            }
            if(stream._videoSender) {
                this._peerconnection.removeTrack(stream._videoSender)
            }
            this.emit('removeLocalStream',stream);

            this._queue.push(async() => {
                await this._unpublish(stream);
            })
        }
    }
    async subscribe(streamId)
    {

        if(this._remoteStreams.get(streamId)){
            return;
        }

        this._queue.push(async() => {
            await this._subscribe(streamId);
        })
    }

    async unsubsribe(streamId) 
    {

        if(this._remoteStreams.get(streamId)){
            return;
        }

        this._queue.push(async() => {
            await this._unsubscribe(streamId);
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
    async generateTestToken(tokenUrl,appkey,room,user)
    { 

        const response = await fetch(tokenUrl, {
            body: JSON.stringify({
                appkey:appkey,
                room:room,
                user:user
            }),
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json'
            },
            method: 'POST'
        });

        let data = await response.json();

        return data.d.token
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

            // next process tick 
            setTimeout(() => {
                console.dir(event)
                const stream = event.streams[0];
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

            }, 0);

        }

        this._peerconnection.onnegotiationneeded = () => {
            logger.debug('onnegotiationneeded')
        }

        this._peerconnection.onicecandidate = (event) => {
            logger.debug('onicecandidate', event.candidate);
        };
    }

    async _unpublish(stream)
    {

        console.log('unpublish stream =========', stream)

        const offer = await this._peerconnection.createOffer();
        await this._peerconnection.setLocalDescription(offer);

        const data = await this._tm.cmd('unpublish', {
            sdp: offer.sdp,
            stream : {
                streamId: stream._stream.id
            }
        })

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: data.sdp
        });

        console.error(answer);
        await this._peerconnection.setRemoteDescription(answer);

    }
    async _publish(stream) 
    {
        console.log('publish stream =========', stream)

        const offer = await this._peerconnection.createOffer();
        await this._peerconnection.setLocalDescription(offer);

        const data = await this._tm.cmd('publish', {
            sdp: offer.sdp,
            stream : {
                streamId: stream._stream.id,
                bitrate: 500,
                attributes: {}
            }
        })

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: data.sdp
        });

        console.error(answer);
        await this._peerconnection.setRemoteDescription(answer)
    }

    async _subscribe(streamId) 
    {
        const data = await this._tm.cmd('subscribe', {
            stream : {
                streamId: streamId
            }
        })

        const offer = new RTCSessionDescription({
            type: 'offer',
            sdp: data.sdp
        });

        console.error(offer);
        await this._peerconnection.setRemoteDescription(offer);

        const answer = await this._peerconnection.createAnswer();
        await this._peerconnection.setLocalDescription(answer);

        await this._tm.cmd('answer', {
            sdp: answer.sdp
        })
    }

    async _unsubscribe(streamId)
    {

        const data = await this._tm.cmd('unsubscribe', {
            stream : {
                streamId: streamId
            }
        })

        const offer = new RTCSessionDescription({
            type: 'offer',
            sdp: data.sdp
        });

        console.error(offer);
        await this._peerconnection.setRemoteDescription(offer);

        const answer = await this._peerconnection.createAnswer();
        await this._peerconnection.setLocalDescription(answer);

        await this._tm.cmd('answer', {
            sdp: answer.sdp
        })
    }

    _setupSignalingClient()
    {

        this._socket = new io.connect(this._auth.wsUrl,{
            reconnection: true,
            reconnectionDelay: 2000,
            reconnectionDelayMax : 10000,
            reconnectionAttempts: 5,
            query: {
                token: this._auth.token
            }
        });


        this._socket.on('connect', async () => {
            await this._join();
        })

        this._socket.on('error', () => {
            this.close();
        })

        this._socket.on('disconnect', (reason) => {
            logger.error('disconnect', reason);
            this.close();
        })


        const tm = new TransactionManager(this._socket);       

        tm.on('cmd', async(cmd) => {
            console.dir(cmd);
        })

        tm.on('event', async(cmd) => {

            if (cmd.name === 'message') {
                this.emit('message', cmd.data)
            }

            if (cmd.name === 'peerconnected') {
                this._handlePeerConnected(cmd.data);
            }

            if (cmd.name === 'peerremoved') {
                this._handlePeerRemoved(cmd.data);
            }

            if (cmd.name === 'configure') {
                this._handleConfigure(cmd.data);
            }

            if (cmd.name === 'streampublished') {
                this._handleStreamPublished(cmd.data)
            }

            if (cmd.name === 'streamunpublished') {
                this._handleStreamUnpublished(cmd.data)
            }
        })

        this._tm = tm;
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
        
        this.emit('joined', peers)
    }

    _handlePeerRemoved(data)
    {
        let peer = data.peer;
        // we do not remove peer here
        this.emit('peerRemoved', peer.peerId);
    }
    _handlePeerConnected(data)
    {
        let peer = data.peer;
        this._peers.set(peer.peerId,peer);

        this.emit('peerConnected', peer.peerId);
    }
    _handleStreamPublished(data)
    {
        let peer = data.peer;
        let stream = data.stream;
        this._peers.set(peer.peerId,peer);

        this.emit('streamPublished', stream, peer);
    }

    _handleStreamUnpublished(data)
    {

        let peer = data.peer;
        let stream = data.stream;
        this._peers.set(peer.peerId,peer);

        let remoteStream = this._remoteStreams.get(stream.streamId);

        if(!remoteStream){
            return;
        }
        this._remoteStreams.delete(remoteStream.streamId)

        this.emit('streamUnpublished', remoteStream)

    }
    _handleConfigure(data)
    {

        let streamId = data.streamId;

        let remoteStream = this._remoteStreams.get(streamId);
        
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
            let muting = data.muting;
            remoteStream._onAudioMuting(muting);
            this.emit('muteRemoteAudio',remoteStream,muting);
            return;
        }
    }
    async _join()
    {
        let planb =  true;
        if(DeviceManager.flag === 'firefox'){
            planb = false;
        } else {
            logger.debug('browser ', DeviceManager.flag, ' is not firefox, planb  ', planb);
        }

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

        let joined = await this._tm.cmd('join', data)
        console.dir(joined)
        await this._handleJoined(joined)

    }
    _sendLeave()
    {
        this._tm.event('leave',{});
    }
    _sendConfigure(data)
    {
        this._tm.event('configure', data);
    }
    _peerForStream(streamId)
    {
        let findPeer;
        for(let peer of this._peers.values()){
            let msids = peer.streams.map((s) => { return s.streamId })
            let msidSet = new Set(msids);
            if(msidSet.has(streamId)){
                findPeer = peer
                break;
            }
        }
        return findPeer; 
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



