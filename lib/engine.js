'use strict';

import events       from 'events';
import webrtc       from 'webrtc-adapter'; // eslint-disable-line no-unused-vars
import jwtDecode    from 'jwt-decode';     // eslint-disable-line no-unused-vars
import Logger       from './logger';

import io           from 'socket.io-client';

import SignalingClient from './signaling';

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
        this._signalingClient = null;
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
        return this._remoteStreams;
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

        const peerconnection = this._createPeerconnection();

        peerconnection.oniceconnectionstatechange = () => 
        {
            logger.debug('iceConnectionState', peerconnection.iceConnectionState);
        };

        const transceiverInit = {
            direction: 'sendonly',
            streams: [stream._stream]
        };

        if(stream._audioTrack) {
            stream._audioTransceiver = await peerconnection.addTransceiver(stream._audioTrack, transceiverInit);
        } 

        if(stream._videoTrack) {
            const transceiver = await peerconnection.addTransceiver(stream._videoTrack, transceiverInit);

            const parameters = transceiver.sender.getParameters();

            if (parameters.encodings[0]) {
                parameters.encodings[0].maxBitrate = stream._videoProfile.bitrate * 1000;
                transceiver.sender.setParameters(parameters);
            }
            stream._videoTransceiver = transceiver;
        }

        stream._peerconnection = peerconnection;

        stream.once('closed', () => {
            this._localStream = null
        })

        await this._publish(stream);

        this.emit('streamPublished');
    }

    async unpublish(stream) 
    {

        if(this._localStream){

            if(stream._audioTransceiver) {
                stream._peerconnection.removeTrack(stream._audioTransceiver.sender);
            }
            if(stream._videoTransceiver) {
                stream._peerconnection.removeTrack(stream._videoTransceiver.sender);
            }

            if (stream._peerconnection) {
                stream._peerconnection.close();
                stream._peerconnection = null;
            }

            await this._unpublish(stream);

            this.emit('streamUnpublished');
        }
    }
    async subscribe(remoteStream)
    {

        if (!remoteStream) {
            logger.error("stream should not be null");
            return;
        }

        const peerconnection = this._createPeerconnection();

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
                this.emit('streamSubscribed', remoteStream);
            }, 0);
        }

        remoteStream._peerconnection = peerconnection;

        remoteStream.once('closed', () => {
            this._remoteStreams.delete(streamId);
        })

        const transceiverInit = {
            direction:'recvonly'
        };

        remoteStream._audioTransceiver = await remoteStream._peerconnection.addTransceiver("audio",transceiverInit);
        remoteStream._videoTransceiver = await remoteStream._peerconnection.addTransceiver("video",transceiverInit);

        await this._subscribe(remoteStream);
    }

    async unsubsribe(remoteStream) 
    {

        if (!remoteStream) {
            logger.error("remote stream does not exist");
            return;
        }

        await this._unsubscribe(remoteStream);

        remoteStream.close();

        this._remoteStreams.delete(remoteStream.streamId);

        this.emit('streamUnsubscribed', remoteStream);
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


        if (this._signalingClient) {
            this._signalingClient.close()
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

    _createPeerconnection()
    {

        let config = {
            iceServers: this._iceServers || [],
            iceTransportPolicy :  this._iceTransportPolicy || 'all',   // relay or all
            iceCandidatePoolSize: this._iceCandidatePoolSize,
            bundlePolicy       : 'max-bundle',
            rtcpMuxPolicy      : 'require',
            sdpSemantics       : 'unified-plan',
            tcpCandidatePolicy: 'disable'
        }; 

        const peerconnection = new RTCPeerConnection(config);

        return peerconnection;
    }

    async _unpublish(stream)
    {

        const data = {
            stream: {
                publisherId: stream._stream.id
            }
        };

        await this._signalingClient.send('unpublish', data);
    }
    async _publish(stream) 
    {

        const offer = await stream._peerconnection.createOffer();
        await stream._peerconnection.setLocalDescription(offer);

        const data = {
            sdp: offer.sdp,
            stream : {
                publisherId: stream.streamId,
                data: {
                    attributes: {}
                }
            }
        }

        const msg = await this._signalingClient.send('publish', data);

        let answer = new RTCSessionDescription({
            type: 'answer',
            sdp: msg.sdp
        });

        await stream._peerconnection.setRemoteDescription(answer);

       
    }

    async _subscribe(stream) 
    {

        const offer = await stream._peerconnection.createOffer()

        await stream._peerconnection.setLocalDescription(offer);

        const data = {
            sdp: offer.sdp,
            stream : {
                publisherId: stream.publisherId
            }
        }

        const msg = await this._signalingClient.send('subscribe', data);

        const answer = new RTCSessionDescription({
            type: 'answer',
            sdp: msg.sdp
        });

        await stream._peerconnection.setRemoteDescription(answer);

    }

    async _unsubscribe(stream)
    {

        const data = {
            stream: {
                publisherId: stream.publisherId,
                subscriberId: stream.streamId
            }
        }

        await this._signalingClient.send('unsubscribe', data);

    }

    _setupSignalingClient()
    {

        this._signalingClient = new SignalingClient(this._signallingServer, {room:this._room});


        this._signalingClient.on('connect', async () => {
            await this._join();
        })


        this._signalingClient.on('disconnect', (reason) => {
            logger.error('disconnect', reason);
            this._close();
        })

        this._signalingClient.on('message', async (data) => {
            this.emit('message', data);
        })

        this._signalingClient.on('close', () => {
            this._close();
        })

        this._signalingClient.on('configure', async (data) => {
            this._handleConfigure(data);
        })

        this._signalingClient.on('streamadded', async (data) => {
            this._handleStreamAdded(data.stream)
        })

        this._signalingClient.on('streamremoved', async (data) => {
            this._handleStreamRemoved(data.stream)
        })

    }

    _handleStreamAdded(stream)
    {
        const {publisherId} = stream;

        let options = {
            local:false,
            audio:true,
            video:true,
            engine:this
        };

        let remoteStream = new RTCStream(options);

        remoteStream._publisherId = publisherId;

        this.emit('streamAdded', remoteStream);
    }

    _handleStreamRemoved(stream)
    {

        const {publisherId} = stream;

        const remoteStream = this._remoteStreamForPublish(publisherId);

        if(!remoteStream){
            console.dir('can not find remote stream', stream);
            return;
        }
        this._remoteStreams.delete(remoteStream.streamId);

        remoteStream.close();

        this.emit('streamRemoved', remoteStream)

    }
    async _join()
    {

        const data = {
            room:this._room
        }


        const joined = await this._signalingClient.send('join', data)

        let streams = joined.room.streams;

        streams.forEach((stream) => {
            this._streams.set(stream.publisherId, stream.data);
        });
        
        this._setState(RTCEngine.CONNECTED);

        this.emit('joined');

        for (let streamInfo of streams) {
            this._handleStreamAdded(streamInfo);
        }

    }
    _sendLeave()
    {

        this._signalingClient.send('leave',{});
    }
    _sendConfigure(data)
    {
        //this._socket.emit('configure', data, () => {});
    }
    _remoteStreamForPublish(streamId){
        let remoteStream = null;
        for (let stream of this._remoteStreams.values()){
            if(stream.publisherId === streamId) {
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



