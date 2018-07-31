'use strict';

import events       from 'events';
import axios        from 'axios';
import webrtc       from 'webrtc-adapter'; // eslint-disable-line no-unused-vars
import jwtDecode    from 'jwt-decode';     // eslint-disable-line no-unused-vars
import Logger       from './Logger';
import sdpTransform from 'sdp-transform'; // eslint-disable-line no-unused-vars 

import io           from 'socket.io-client';


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
        this._iceServers = [];
        this._peerconnection = null;
        this._iceConnected = false;
        this._msAttributes = new Map();  // {msid:attributes}
        this._socket = null;

    }
    addStream(stream)
    {
        if(this._state !== RTCEngine.CONNECTED){
            throw new Error('must addStream after join room')
        }

        // we should start local medis before we start 
        stream._engine = this;

        stream.setupLocalMedia()
        .then(() => {

            if(this._localStreams.get(stream.streamId)){
                return;
            }

            stream._peerconnection = this._peerconnection;
            
            if(stream._hasMedia){

                if(stream._stream.getVideoTracks().length > 0){
                    let videoTrack = stream._stream.getVideoTracks()[0]
                    this._peerconnection.addTrack(videoTrack,stream._stream)
                }
                if(stream._stream.getAudioTracks().length > 0){
                    let audioTrack = stream._stream.getAudioTracks()[0]
                    this._peerconnection.addTrack(audioTrack,stream._stream)
                }
            }

            this._localStreams.set(stream.streamId,stream);

            stream._peerId = this._auth.user;
            stream._setMaxBitrate();

            this._reOffer();
            // todo  
            this._addStream(stream);

        }) 
        .catch((error) => {
            logger.error('addStream error ', error);
        });
    }
    removeStream(stream)
    {
        if(this._localStreams.get(stream.streamId)){
            this._localStreams.delete(stream.streamId);

            if(this._peerconnection){
                this._peerconnection.removeStream(stream._stream);
            }

            this._reOffer();

            // todo

            this._removeStream(stream);

            this.emit('removeLocalStream',stream);
        }
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
            this.emit('error', error)
            return;
        }
        this._auth.token = token;

        logger.debug('auth token ', this._auth);

        // iceservers
        this._iceServers = this._auth.iceServers;

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
    generateTestToken(tokenUrl,appSecret,room,user,callback)
    { 
        axios.post(tokenUrl,{
            secret:appSecret,
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
            if(stream._stream){
                this._peerconnection.removeStream(stream._stream);
            }
        }

        for(let stream of this._remoteStreams.values()){
            stream._close();
            this.emit('removeRemoteStream', stream);
        }
        this._remoteStreams.clear();

        try {
            this._peerconnection.close();
        } catch (error) {
            logger.error('peerconnection close error ', error);
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
                iceTransportPolicy : 'all',   // relay or all
                bundlePolicy       : 'max-bundle',
                rtcpMuxPolicy      : 'require'    
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
        };

        this._peerconnection.onaddstream = (event) => {
            
            const stream = event.stream;

            logger.debug('peerconnection "addstream" event [stream:%o]', stream);

            let peerId = this._peerForStream(stream.id);

            if(!peerId){
                logger.error('can not find peer for stream ', stream.id);
                return; 
            }

            let options = {
                stream:stream,
                local:false,
                audio:!!stream.getAudioTracks().length,
                video:!!stream.getVideoTracks().length,
                peerId:peerId 
            };

            let remoteStream = new RTCStream(options);

            stream.onaddtrack = (event) => {
                let track = event.track;
                remoteStream.emit('addtrack', track);
            };

            stream.onremovetrack = (event) => {
                let track = event.track;
                remoteStream.emit('removetrack', track);
            };

            this._remoteStreams.set(stream.id, remoteStream);
            
            if(this._msAttributes.get(stream.id)){
                remoteStream._setAttributes(this._msAttributes.get(stream.id));
            }

            this.emit('addRemoteStream', remoteStream);

        };

        this._peerconnection.onremovestream = (event) => {

            const stream = event.stream;

            logger.debug('peerconnection "removestream" event [stream:%o]', stream);

            let peerId = this._peerForStream(stream.id);

            if(!peerId){
                logger.error('can not find peer for stream ', stream.id);
            }

            let remoteStream = this._remoteStreams.get(stream.id);

            if(!remoteStream){
                return;
            }

            this.emit('removeRemoteStream', remoteStream);
        };
    }

    _removeStream(stream)
    {
        this._getOffer()
        .then((offer) => {

            this._socket.emit('removeStream', {
                stream: stream.dump(),
                sdp: offer.sdp
            })
        })
        .catch((error) => {

            logger.error('removeStream error', error);
            throw error;
        })
    }

    _addStream(stream)
    {

        this._getOffer()
        .then((offer) => {

            this._socket.emit('addStream', {
                stream: stream.dump(),
                sdp: offer.sdp
            })
        })
        .catch((error) => {

            logger.error('addStream error ', error);
            throw error;
        })
    }

    _reOffer() 
    {

        if(DeviceManager.flag == 'safari'){
            logger.error(DeviceManager.flag,  ' addTransceiver ')
            this._peerconnection.addTransceiver('audio');
            this._peerconnection.addTransceiver('video');
        } 

        this._peerconnection.createOffer({
            offerToReceiveAudio : 1,
            offerToReceiveVideo : 1
        })
        .then((offer) => {
            return this._peerconnection.setLocalDescription(offer)
        })
        .then(() => 
        {
            let offer = this._peerconnection.localDescription
            this._socket.emit('offer', {
                sdp: offer.sdp
            })

        })
        .catch((error) => {

            logger.error('offer error ', error);

            throw error;
        }); 
    }
    _getOffer()
    {

        if(!this._peerconnection){
          throw Error('peerconnection does not init')
        }

        // some  compatibility
        if(DeviceManager.flag == 'safari'){
          this._peerconnection.addTransceiver('audio');
          this._peerconnection.addTransceiver('video');
        }

        return this._peerconnection.createOffer({
            offerToReceiveAudio : true,
            offerToReceiveVideo : true
        })
        .then((offer) => {
            return this._peerconnection.setLocalDescription(offer)
        })
        .then(() => {
          return this._peerconnection.localDescription.sdp
        })
        .catch((error) => {
            logger.error('getoffer error', error)
            throw error;
        })
    }
    _setupSignalingClient()
    {

        this._socket = new io.connect(this._auth.wsUrl,{
            'reconnection': true,
            'reconnectionDelay': 2000,
            'reconnectionDelayMax' : 10000,
            'reconnectionAttempts': 5
        });


        this._socket.on('connect', () => {
            this._join();
        })

        this._socket.on('error', (err) => {
            this._close(err);
        })

        this._socket.on('disconnect', (reason) => {
            logger.error('disconnect', reason);
            this._close();
        })

        this._socket.on('reconnect', (attemptNumber) => {
            logger.error('reconnect attemptNumber', attemptNumber);
            this.emit('reconnect', attemptNumber);
            this._setState(RTCEngine.CONNECTING);
        })

        this._socket.on('joined', (data) => {
            this._handleJoined(data);
        })

        this._socket.on('offer', (data) => {
            this._handleOffer(data);
        })

        this._socket.on('answer', (data) => {
            this._handleAnswer(data);
        })

        this._socket.on('peer_removed', (data) => {
            this._handlePeerRemoved(data);
        })

        this._socket.on('peer_connected', (data) => {
            this._handlePeerConnected(data);
        })

        this._socket.on('stream-added', (data) => {
            this._handleStreamAdded(data);
        })

        this._socket.on('configure', (data) => {
            this._handleConfigure(data);
        })

        this._socket.on('attributes', (data) => {
            this._handleAttributes(data);
        })


    }

    _handleJoined(data)
    {
        let peers = data.room.peers;

        peers.forEach((peer) => {
            this._peers.set(peer.id, peer);
        });

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: data.sdp
        });

        this._peerconnection.setRemoteDescription(answer)
          .catch((error) => {
              logger.error('setRemoteDescription error ', error);
          });

        // for reconnect
        for(let stream of this._localStreams){
            if(stream._stream){
                this._peerconnection.addStream(stream._stream)
            }
        }

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
            this._peers.set(peer.id, peer);
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
        this._peers.set(peer.id,peer);

        this.emit('peerConnected', peer.id);
    }
    _handleConfigure(data)
    {

        let msid = data.msid;
        
        let remoteStream = this._remoteStreams.get(msid);
        
        if(!remoteStream){
            return;
        }

        if('video' in data){
            let muted = !data.video;
            this.emit('muteRemoteVideo',remoteStream,muted);
            return;
        }

        if('audio' in data){
            let muted = !data.audio;
            this.emit('muteRemoteAudio',remoteStream,muted);
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
    _handleStreamAdded(data)
    {
        let msid = data.msid 
        let stream = this._localStreams.get(msid)
        if(stream){
            this.emit('addLocalStream', stream)
        }
    }
    _join()
    {

        let planb =  true;
        if(DeviceManager.flag === 'firefox'){
            planb = false;
        } else {
            logger.debug('browser ', DeviceManager.flag, ' is not firefox, planb  ', planb);
        }

        // init pc first
        this._createPeerConnection();

        this._getOffer()
        .then((offer) => {

            const data = {
                appkey:this._auth.appkey,
                room:this._auth.room,
                user:this._auth.user,
                token:this._auth.token,
                planb:planb,
                sdp:offer
            }

            this._socket.emit('join', data)
        })
        .catch((error) => {
            logger.error('join error', error)
            this.emit('error', error)
        })

    }
    _sendLeave()
    {
        this._socket.emit('leave', {})
    }
    _sendConfigure(data)
    {
        this._socket.emit('configure', data);
    }
    _updateAttributes(data)
    {
        this._socket.emit('attributes', data);
    }
    _peerForStream(streamId)
    {
        let peerId;
        for(let peer of this._peers.values()){
            let msids = new Set(peer.msids);
            if(msids.has(streamId)){
                peerId = peer.id;
                break;
            }
        }
        return peerId; 
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



