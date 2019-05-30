'use strict';

import events       from 'events';
import webrtc       from 'webrtc-adapter'; // eslint-disable-line no-unused-vars
import jwtDecode    from 'jwt-decode';     // eslint-disable-line no-unused-vars
import Logger       from './logger';

import io           from 'socket.io-client';

import RTCStream   from './stream';

const logger = new Logger('RTCEngine');


class RTCEngine extends events.EventEmitter
{
    constructor()
    {
        super();
        this.setMaxListeners(Infinity);

        this._localStream = null;
        this._remoteStreams = new Map();

        this._state = RTCEngine.NEW;
        this._streams = new Map();

        this._signallingServer = null;
        this._room = null;
        this._iceServers = null;
        this._iceTransportPolicy = null;
        this._iceConnected = false;
        this._iceCandidatePoolSize = 1;


        this._socket = null;
    }

    getState () 
    {
        return this._state;
    }

    getLocalStream()
    {
        return this._localStream
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

        // we should start local media before we start 
        stream._engine = this;

        this._localStream = stream;

        let options = {
            iceServers: this._iceServers || [],
            iceTransportPolicy :  this._iceTransportPolicy || 'all',   // relay or all
            iceCandidatePoolSize: this._iceCandidatePoolSize,
            bundlePolicy       : 'max-bundle',
            rtcpMuxPolicy      : 'require',
            sdpSemantics       : 'unified-plan',
            tcpCandidatePolicy: 'disable',
            IceTransportsType: 'nohost'
        };  // eslint-disable-line no-unused-vars 

        const peerconnection = new RTCPeerConnection(options);

        peerconnection.oniceconnectionstatechange = () => 
        {
            logger.debug('iceConnectionState', peerconnection.iceConnectionState);
        };


        if(stream._audioTrack) {
            stream._audioSender = await peerconnection.addTrack(stream._audioTrack,stream._stream)
        }

        if(stream._videoTrack) {
            stream._videoSender = await peerconnection.addTrack(stream._videoTrack,stream._stream)
        }

        stream._peerconnection = peerconnection;

        stream.once('closed', () => {
            this._localStream = null
        })

        await this._publish(stream)

    }

    async unpublish(stream) 
    {

        if(this._localStream){

            if(stream._audioSender) {
                stream._peerconnection.removeTrack(stream._audioSender)
            }
            if(stream._videoSender) {
                stream._peerconnection.removeTrack(stream._videoSender)
            }
            this.emit('removeLocalStream',stream);
            
            await this._unpublish(stream);

            stream.close();
        }
    }
    async subscribe(streamId)
    {

        if(this._remoteStreamForPublish(streamId)) {
            return;
        }

        let options = {
            local:false,
            audio:true,
            video:true,
            engine:this
        };

        let remoteStream = new RTCStream(options);

        remoteStream._publisherId = streamId;

        let config = {
            iceServers: this._iceServers || [],
            iceTransportPolicy :  this._iceTransportPolicy || 'all',   // relay or all
            iceCandidatePoolSize: this._iceCandidatePoolSize,
            bundlePolicy       : 'max-bundle',
            rtcpMuxPolicy      : 'require',
            sdpSemantics       : 'unified-plan',
            tcpCandidatePolicy: 'disable',
            IceTransportsType: 'nohost'
        }; 

        const peerconnection = new RTCPeerConnection(config);

        peerconnection.oniceconnectionstatechange = () => 
        {
            logger.debug('iceConnectionState', peerconnection.iceConnectionState);
        };

        peerconnection.ontrack = (event) => {

            setTimeout(() => {

                const stream = event.streams[0];

                if (this._remoteStreams.get(stream.id)) {
                    return;
                }

                remoteStream._setMediastream(stream);

                this._remoteStreams.set(remoteStream.streamId, remoteStream);

                this.emit('addRemoteStream', remoteStream);
            }, 0);
        }

        remoteStream._peerconnection = peerconnection;

        remoteStream.once('closed', () => {
            this._remoteStreams.delete(streamId);
        })

        await this._subscribe(streamId, remoteStream);
    }

    async unsubsribe(streamId) 
    {

        const remoteStream = this._remoteStreamForPublish(streamId);

        if (!remoteStream) {
            return;
        }

        await this._unsubscribe(remoteStream);

        remoteStream.close();

        this._remoteStreams.delete(remoteStream.streamId);
    }

    joinRoom(room, signallingServer, config)
    {
        if(this._state === RTCEngine.CONNECTED){
            logger.error("RTCEngine has connected");
            return;
        }

        // iceservers
        this._iceServers = config.iceServers || [];

        this._signallingServer = signallingServer;

        this._room = room;

        // iceTransportPolicy
        this._iceTransportPolicy =  config.iceTransportPolicy || 'all';

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

    _close()
    {
        if(this._state === RTCEngine.DISCONNECTED){
            return;
        }

        this._setState(RTCEngine.DISCONNECTED);

        if (this._socket) {
            this._socket.close()
        }

        if (this._localStream) {
            if (this._localStream._audioSender) {
                this._localStream._peerconnection.removeTrack(this._localStream._audioSender)
            }
            if (this._localStream._videoSender) {
                this._localStream._peerconnection.removeTrack(this._localStream._videoSender)
            }
        }

        for(let stream of this._remoteStreams.values()){
            stream.close();
            this.emit('removeRemoteStream', stream);
        }

        this._remoteStreams.clear();
        this._localStream = null;
    }
    _setState(state)
    {
        if(this._state === state){
            return;
        }
        this._state = state;
        this.emit('state', this._state);
    }

    async _unpublish(stream)
    {

        return new Promise((resolve) => {

            const data = {
                stream: {
                    publisherId: stream._stream.id
                }
            };

            this._socket.emit('unpublish', data, () => {
                resolve();
            })
        }) 
    }
    async _publish(stream) 
    {

        const offer = await stream._peerconnection.createOffer();
        await stream._peerconnection.setLocalDescription(offer);

        // todo error handle 
        return new Promise((resolve) => {

            const data = {
                sdp: offer.sdp,
                stream : {
                    publisherId: stream._stream.id,
                    data: {
                        bitrate: 500,
                        attributes: {}
                    }
                }
            }

            this._socket.emit('publish', data, async (msg) => {

                let answer = new RTCSessionDescription({
                    type: 'answer',
                    sdp: msg.sdp
                });

                await stream._peerconnection.setRemoteDescription(answer);

                resolve();
            })
        })

    }

    async _subscribe(streamId, stream) 
    {

        stream._peerconnection.addTransceiver("audio",{direction:"recvonly"});
        stream._peerconnection.addTransceiver("video",{direction:"recvonly"});

        const offer = await stream._peerconnection.createOffer()

        await stream._peerconnection.setLocalDescription(offer);

        return new Promise((resolve) => {

            const data = {
                sdp: offer.sdp,
                stream : {
                    publisherId: streamId
                }
            }

            this._socket.emit('subscribe', data, async (msg) => {

                const attributes = msg.stream.data;
                stream._setAttributes(attributes);
        
                const answer = new RTCSessionDescription({
                    type: 'answer',
                    sdp: msg.sdp
                });
        
                await stream._peerconnection.setRemoteDescription(answer);

                resolve();
            })
            
        })


    }

    async _unsubscribe(stream)
    {

        return new Promise((resolve) => {
            this._socket.emit('unsubscribe', {
                stream : {
                    publisherId: stream._publisherId,
                    subscriberId: stream.streamId
                }
            }, () => {
                resolve();
            })
        })
       
    }

    _setupSignalingClient()
    {

        this._socket = new io.connect(this._signallingServer,{
            reconnection: true,
            reconnectionDelay: 2000,
            reconnectionDelayMax : 10000,
            reconnectionAttempts: 5,
            query: {
                room: this._room,
                user: this._user
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
            this._close();
        })

        this._socket.on('message', async (data) => {
            this.emit('message', data);
        })

        this._socket.on('configure', async (data) => {
            this._handleConfigure(data);
        })

        this._socket.on('streampublished', async (data) => {
            this._handleStreamPublished(data)
        })

        this._socket.on('streamunpublished', async (data) => {
            this._handleStreamUnpublished(data)
        })

    }

    _handleStreamPublished(data)
    {
        let stream = data.stream;

        this.emit('streamPublished', stream);
    }

    _handleStreamUnpublished(data)
    {

        let stream = data.stream;

        const remoteStream = this._remoteStreamForPublish(stream.publisherId);

        if(!remoteStream){
            console.dir('can not find remote stream', stream);
            console.dir(this._remoteStreams)
            return;
        }
        this._remoteStreams.delete(remoteStream.streamId);

        remoteStream.close();

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

        const data = {
            room:this._room,
            user:this._user
        }

        this._socket.emit('join', data, async (joined) => {

            let streams = joined.room.streams;

            streams.forEach((stream) => {
                this._streams.set(stream.publisherId, stream.data);
            });
            
            this._setState(RTCEngine.CONNECTED);

            this.emit('joined');

            for (let stream of streams) {
                this.emit('streamPublished', stream);
            }

        })
    }
    _sendLeave()
    {
        this._socket.emit('leave', {}, () => {});
    }
    _sendConfigure(data)
    {
        this._socket.emit('configure', data, () => {});
    }
    _remoteStreamForPublish(streamId){
        let remoteStream = null;
        for (let stream of this._remoteStreams.values()){
            if(stream._publisherId === streamId) {
                remoteStream = stream;
                break;
            }
        }
        return remoteStream;
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



