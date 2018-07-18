'use strict';

import events       from 'events';
import axios        from 'axios';
import webrtc       from 'webrtc-adapter'; // eslint-disable-line no-unused-vars
import jwtDecode    from 'jwt-decode';     // eslint-disable-line no-unused-vars
import Logger       from './Logger';
import SignalingClient from './signaling';
import sdpTransform from 'sdp-transform'; // eslint-disable-line no-unused-vars 


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

                logger.error("addStream  ==============", stream._stream);
                this._peerconnection.addStream(stream._stream);
                // if(stream._stream.getVideoTracks().length > 0){
                //     let videoTrack = stream._stream.getVideoTracks()[0]
                //     this._peerconnection.addTrack(videoTrack,stream._stream)
                // }
                // if(stream._stream.getAudioTracks().length > 0){
                //     let audioTrack = stream._stream.getAudioTracks()[0]
                //     this._peerconnection.addTrack(audioTrack,stream._stream)
                // }
            }

            this._localStreams.set(stream.streamId,stream);

            stream._peerId = this._auth.user;
            stream._setMaxBitrate();
            stream._updateAttributes();

            this._reOffer();

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

            self.emit('removeLocalStream',stream);
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
                iceTransportPolicy : 'all',   // relay
                bundlePolicy       : 'max-bundle',
                rtcpMuxPolicy      : 'require'    
        };  // eslint-disable-line no-unused-vars 

        this._peerconnection = new RTCPeerConnection(options);

        this._peerconnection.oniceconnectionstatechange = (event) => 
        {
        
            logger.debug('iceconnectionstatechange ===== ', event ,this._peerconnection.iceConnectionState);

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

        this._peerconnection.onnegotiationneeded = (event) => {

        };

        ////// todo  remote stream  handle 
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

            stream.addEventListener('addtrack', (event) => {
                let track = event.track;
                remoteStream.emit('addtrack', track);
            });

            stream.addEventListener('removetrack', (event) => {
                let track = event.track;
                logger.debug('stream "removetrack" event [track:%o]', track);

                remoteStream.emit('removetrack', track);
            });

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
            const offer =  this._peerconnection.localDescription
            let msg = {
                type:'offer',
                from:this._auth.user,
                data:{
                    sdp:offer.sdp
                }
            };
            
            this._signaling.sendMessage(msg);
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
        let options = {
            token:this._auth.token,
            room:this._auth.room,
            user:this._auth.user,
            wsURL:this._auth.wsUrl
        };

        this._signaling = new SignalingClient(options);

        this._signaling.on('open', () => {
            this._join();
        });

        this._signaling.on('close', (err) => {
            this._close(err);
        });

        this._signaling.on('connecting', (currentAttempt) => {
            // todo set state
            logger.debug('connecting ', currentAttempt);
            this._setState(RTCEngine.CONNECTING);
        });

        this._signaling.on('disconnected', () => {
            // todo 
            this._close();
        })

        this._signaling.on('error', (err) => {
            logger.error('error', err);
        })

        this._signaling.on('message',(msg,callback) =>{
            this._handleMessage(msg,callback);
        });
    }
    _handleMessage(msg)
    {

        if(msg.type === 'audioLevels'){
            this._handleAudioLevels(msg);
            return;
        }

        if(msg.type === 'joined'){
            this._handleJoined(msg);
            return;
        }

        if(msg.type === 'offer'){
            this._handleOffer(msg);
            return;
        }

        if(msg.type === 'answer'){
            this._handleAnswer(msg);
        }
        
        if(msg.type === 'peer_removed'){
            this._handlePeerRemoved(msg);
            return;
        }

        if(msg.type === 'peer_connected'){
            this._handlePeerConnected(msg);
            return;
        }

        if(msg.type === 'peer_updated'){
            this._handlePeerUpdated(msg);
            return;
        }
        
        if(msg.type === 'error'){
            this._handleError(msg);
            return;
        }

        if(msg.type === 'streamAdded'){
            this._handleStreamAdded(msg);
            return;
        }

        if(msg.type === 'configure'){
            this._handleConfigure(msg);
            return;
        }

        if(msg.type === 'attributes'){
            this._handleAttributes(msg);
            return;
        }

    }
    _handleJoined(msg)
    {
        let data = msg.data;
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
    _handleOffer(msg)
    {

        let data = msg.data;
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
    _handleAnswer(msg)
    {

        let data = msg.data;
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
    _handlePeerRemoved(msg)
    {
        let peer = msg.data.peer;
        // we do not remove peer here
        this.emit('peerRemoved', peer.id);
    }
    _handlePeerConnected(msg)
    {
        let peer = msg.data.peer;
        this._peers.set(peer.id,peer);

        this.emit('peerConnected', peer.id);
    }
    _handlePeerUpdated(msg)
    {
        let peer = msg.data.peer;
        this._peers.set(peer.id,peer);
    }
    _handleConfigure(msg)
    {

        let msid = msg.data.msid;
        
        let remoteStream = this._remoteStreams.get(msid);
        
        if(!remoteStream){
            return;
        }

        if('video' in msg.data){
            let muted = !msg.data.video;
            this.emit('muteRemoteVideo',remoteStream,muted);
            return;
        }

        if('audio' in msg.data){
            let muted = !msg.data.audio;
            this.emit('muteRemoteAudio',remoteStream,muted);
            return;
        }
    }
    _handleAudioLevels(msg){

        let audioLevels  = msg.data.audioLevels;
        if(audioLevels && audioLevels.length > 0){
            for(let audioLevel of audioLevels){
                let msid = audioLevel.msid;
                let level = audioLevel.audioLevel;
                
                let stream = this._remoteStreams.get(msid) || this._getLocalStreamById(msid);
                if(stream){
                     this.emit('audioLevel',stream,level);
                }
            }
        }

    }
    _handleAttributes(msg)
    {
        let msid = msg.data.msid 
        let attributes = msg.data.attributes 

        this._msAttributes.set(msid,attributes)

        let remoteStream = this._remoteStreams.get(msid)
        if(!remoteStream){
            return;
        }
        remoteStream._setAttributes(attributes)
    }
    _handleError(msg)
    {
        logger.debug('handleError ', msg);
    }
    _handleStreamAdded(msg)
    {
        let msid = msg.data.msid 
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

            let msg = {
                type:'join',
                from:this._auth.user,
                data:{
                    appkey:this._auth.appkey,
                    room:this._auth.room,
                    user:this._auth.user,
                    token:this._auth.token,
                    planb:planb,
                    sdp:offer
                }    
            };
            this._signaling.sendMessage(msg);
        })
        .catch((error) => {
            logger.error('join error', error)
            this.emit('error', error)
        })

    }
    _sendLeave()
    {
        let msg = {
            type:'leave',
            from:this._auth.user,
            data:{}
        };

        this._signaling.sendMessage(msg);
    }
    _sendConfigure(data)
    {
        let msg = {
            type:'configure',
            from:this._auth.user,
            data:data
        };

        this._signaling.sendMessage(msg);
    }
    _updateAttributes(data)
    {
        let msg = {
            type:'attributes',
            from: this._auth.user,
            data: data
        }

        this._signaling.sendMessage(msg);
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



