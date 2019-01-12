'use strict';

import events       from 'events';
import DeviceManager from './device'
import * as utils   from './utils';
import Logger       from './Logger';
import {VideoProfile,iosVideoProfile} from './profile'

const logger = new Logger('RTCStream');

export default class RTCStream extends events.EventEmitter
{
    constructor(options)
    {
        super();
        this.setMaxListeners(Infinity);
        
        this._stream = options.stream || null;  // the real mediastream
        this._local = true;
        this._audio = options.audio;
        this._video = options.video;
        this._screen = options.screen; // no screen for now 
        this._attributes = options.attributes  || {};
        this._videoProfile = VideoProfile.VideoProfile_240P;
        this._peerId =  options.peerId || null;
        this._failed = false;
        this._peerconnection = null;
        this._audioTrack = null;
        this._videoTrack = null;
        this._settingupMedia = false;
        this._audioInput = null;
        this._videoInput = null;
        this._videoElement = null;
        this._hasMedia = false || !!options.stream

        this._publisherId = null;

        this._audioMuted = false;
        this._videoMuted = false;

        if (options.engine) {
            this._engine = options.engine;
        }

        this._audioSender = null;
        this._videoSender = null;

        if(options.local == false){
            this._local = false;
        }

        if(this._hasMedia){
            this._setMediastream(options.stream)
        }

        if(this._video && this._screen){
            throw 'can not have video and screen both';
        }
        
        if(!(this._audio || this._video || this._screen)){
            throw 'audio video screen can not be null both';
        }
        
    }
    get streamId()
    {
        return this._stream ? this._stream.id : "";
    }
    get isLocal()
    {
        return this._local;
    }
    get audioTrack()
    {
        return this._audioTrack;
    }
    get videoTrack()
    {
        return this._videoTrack;
    }
    get mediastream()
    {
        return this._stream;
    }
    get videoProfile()
    {
        return this._videoProfile;
    }
    get peerId()
    {
        return this._peerId;
    }
    get videoElement()
    {
        return this._videoElement;
    }
    set videoProfile(videoProfile)
    {
        if(this._videoProfile == videoProfile){
            return;
        }
        this._videoProfile = videoProfile;

    }
    get attributes()
    {
        return this._attributes;
    }

    get audioMuted()
    {
        return this._audioMuted;
    }

    get videoMuted()
    {
        return this._videoMuted;
    }

    async setupLocalMedia()
    {
        if(!this._local){
            throw 'have to be local when try to enable media';
        }

        if(this._hasMedia){
            return;
        }

        // init the local stream 
        let constraints = this._getMediaConstraints({
            video: this._video ?  {deviceId:undefined}:undefined,
            audio: this._audio ?  {deviceId:undefined}:undefined
        })

        const stream = await navigator.mediaDevices.getUserMedia(constraints);

        this._setMediastream(stream);
        this.emit('initLocalStream',this);
    }
    shutdownLocalMedia()
    {
        if(this._local){
            if(this._hasMedia){
                this._stream.getTracks().forEach( (track) =>{
                    track.stop();
                    this._stream.removeTrack(track) 
                });
                if(this._videoElement){
                    this._videoElement.srcObject = null
                }
                this._hasMedia = false
                this._videoElement = null 
                this.emit('shutdownLocalMedia',null);
            }
        }
    }
    close()
    {
        if(this._local){
            if(this._stream){
                this._stream.getTracks().forEach(function (track) {
                    track.onended = null;
                    track.stop();
                });
                this.emit('shutdownLocalMedia',null);
            }
        } 

        if (this._peerconnection) {
            this._peerconnection.close();
        }
    }
    changeAudioInput(deviceId)
    {
        logger.debug('changeAudioInput ',deviceId)

        if(!this._audio){
            logger.debug('can not change audio input on audio disable stream')
            return 
        }
        if(!this._hasMedia){
            logger.debug('can not change audio input on uninited stream')
            return
        }

        return Promise.resolve()
            .then(() => {
                return this._changeAudioInput(deviceId)
            })
            .then((device) => {
                if(!device){
                    return 
                }
                let constraints = this._getMediaConstraints({
                    audio:{deviceId:deviceId}
                })
                return this._getLocalStream(constraints)
                    .then((newStream) => {
                        let newAudioTrack = newStream.getAudioTracks()[0];
                        let stream = this._stream;
                        let oldAudioTrack = stream.getAudioTracks()[0]

                        stream.removeTrack(oldAudioTrack);
                        oldAudioTrack.stop();

                        if(this._peerconnection){
                            this._peerconnection.addTrack(newAudioTrack,stream)
                        }
                        this.emit('localStreamUpdate', stream)
                        this._setMediastream(stream)
                    })
                    .then(() => {
                        // need 
                        if(this._engine){
                            this._engine._reOffer()
                        } else {
                            
                        }
                    })
                    .catch((err) => {
                        logger.debug('changeAudioInput error',err)
                    });
            })

    }
    changeVideoInput(deviceId)
    {
        logger.debug('changeVideoInput ', deviceId)
        
        if(!this._video){
            logger.debug('can not change video input on video disable stream')
            return
        }
        if(!this._stream){
            logger.debug('can not change video input on uninited stream')
            return
        } 
        return Promise.resolve()
            .then(() => {
                return this._changeVideoInput(deviceId)
            })
            .then((device) => {
                if(!device){
                    return
                }
                let constraints = this._getMediaConstraints({
                    video:{deviceId:deviceId}
                })
                return this._getLocalStream(constraints)
                    .then((newStream) => {
                        let newVideoTrack = newStream.getVideoTracks()[0]
                        let stream = this._stream
                        let oldVideoTrack = stream.getVideoTracks()[0]

                        stream.removeTrack(oldVideoTrack)
                        oldVideoTrack.stop()

                        if(this._peerconnection){
                            this._peerconnection.addTrack(newVideoTrack,stream)
                        }
                        
                        this.emit('localStreamUpdate', stream)

                        this._setMediastream(stream)
                    })
                    .then(() => {
                        
                        if(this._engine){
                            this._engine._reOffer()
                        } else {
                            logger.error('changeVideoInput can not renegotiation') 
                        }
                    })
                    .catch((err) => {
                        logger.error('changeVideoInput error', err)
                    })
            })
    }
    _changeAudioInput(deviceId)
    {
        return Promise.resolve()
                .then(() => {
                    return DeviceManager.getDevices()
                })
                .then(() => {
                    let array = Array.from(DeviceManager.audioInputs)
                    let len = array.length 

                    let currentDeviceId = this._audioInput ? this._audioInput.deviceId : undefined 

                    if(deviceId === currentDeviceId){
                        return 
                    }

                    if(len === 0){
                        this._audioInput = null;
                        return
                    } 

                    if(!DeviceManager.audioInputs.has(deviceId)){
                        return 
                    }

                    return DeviceManager.audioInputs.get(deviceId)
                })
    }
    _changeVideoInput(deviceId)
    {
        return Promise.resolve()
            .then(() => {
                return DeviceManager.getDevices()
            })
            .then(() => {
                let array = Array.from(DeviceManager.videoInputs)
                let len = array.length 
                
                let currentDeviceId = this._videoInput ? this._videoInput.deviceId : undefined;

                if(deviceId === currentDeviceId){
                    return
                }

                if(len === 0){
                    return
                }

                if(!DeviceManager.videoInputs.has(deviceId)){
                    return
                }

                return DeviceManager.videoInputs.get(deviceId)
            })
    }
    muteAudio(muting)
    {
        logger.debug('mute auido');

        if(!this._audioTrack){
            logger.debug('mute audio but can not find audiotrack');
            return;
        }

        if (this._audioTrack.enabled == !muting) {
            return
        }

        this._audioTrack.enabled = !muting;

        this._audioMuted = muting;

        if(this._local){
            // local
            if(this._engine){
                let data = {
                    audio: true,
                    peerId:this._peerId,
                    local:true,
                    muting: muting,
                    trackId: this._audioTrack.id,
                    streamId: this._stream.id
                }
                this._engine._sendConfigure(data)
            }
        } else {
            // remote 
            if(this._engine) {
                let data = {
                    audio: true,
                    peerId: this._peerId,
                    local:false,
                    muting: muting,
                    trackId: this._audioTrack.id,
                    streamId: this._stream.id
                }
                this._engine._sendConfigure(data)
            }
        }
    
    }
    muteVideo(muting)
    {
        if(!this._videoTrack){
            logger.debug('mute video but can not find videotrack ');
            return;
        }

        if (this._videoTrack.enabled == !muting) {
            return;
        }

        this._videoTrack.enabled = !muting;

        this._audioMuted = muting;

        if(this._local){
            // local 
            if(this._engine){
                let data = {
                    video:true,
                    peerId:this._peerId,
                    local:true,
                    muting: muting,
                    trackId: this._videoTrack.id,
                    streamId: this._stream.id
                };
                this._engine._sendConfigure(data);
            }
        } else {
            // remote 
            if(this._engine){
                let data = {
                    video:true,
                    peerId:this._peerId,
                    remote:true,
                    muting: muting,
                    trackId: this._videoTrack.id,
                    streamId: this._stream.id
                };
                this._engine._sendConfigure(data);
            }
        }
    }

    _onVideoMuting(muting)
    {

        if (this._videoTrack) {

            this._videoTrack.enabled = !muting;
        }

    }
    _onAudioMuting(muting)
    {
        if (this._audioTrack) {
            
            this._audioTrack.enabled = !muting;
            
        }
    }
    _getMediaConstraints(media)
    {
        let constraints = {};
        if(media.video){  
            constraints.video = {};
            constraints.video.width = {ideal:this._videoProfile.width};
            constraints.video.height = {ideal:this._videoProfile.height};
            constraints.video.frameRate = {ideal:this._videoProfile.fps};
            if(media.video.deviceId){
                constraints.video.deviceId = media.video.deviceId;
            }
        }
        if(media.audio){
            constraints.audio = {};
            if(media.audio.deviceId){
                constraints.audio.deviceId = media.audio.deviceId;
            } else {
                constraints.audio = true;
            }
        }  
        // iOS 
        if(DeviceManager.name === 'safari' && DeviceManager.browser.ios && media.video){
            logger.debug('this is ios safari')
            let profilekey = utils.getKey(VideoProfile,this._videoProfile);
            let profile = iosVideoProfile[profilekey];
            constraints.video.width = profile.width;
            constraints.video.height = profile.height;
            if(media.video.deviceId){
                constraints.video.deviceId = media.video.deviceId;
            } 
        }

        return constraints
    }
    _getLocalStream(constraints)
    {
        logger.debug('getLocalStream ', constraints);
        return navigator.mediaDevices.getUserMedia(constraints);
    }
    _setMediastream(stream)
    {

        this._hasMedia = true;

        if(stream.getAudioTracks().length > 0){
            this._audioTrack = stream.getAudioTracks()[0]

        }
        if(stream.getVideoTracks().length > 0){
            this._videoTrack = stream.getVideoTracks()[0]
        }

        this._stream = stream;

        if(!this._videoElement){
            this._videoElement = document.createElement('video');
            
            this._videoElement.setAttribute('playsinline', true);
            this._videoElement.setAttribute('autoplay', true);

            this._videoElement.onloadedmetadata = () => {

                this._videoElement.width = this._videoElement.videoWidth;
                this._videoElement.height = this._videoElement.videoHeight;
            };

            this._videoElement.onresize = () => {

                logger.debug('onresize ', this._videoElement.videoWidth, this._videoElement.videoHeight);
            };

            if(this._local){
                this._videoElement.muted= true;
            }
        }

        if (this._videoElement.srcObject) {
            this._videoElement.pause();
            this._videoElement.srcObject = this._stream;
            this._videoElement.play();
        } else {
            this._videoElement.srcObject = this._stream;
        }
        //this._videoElement.play();
        logger.debug("set media stream", stream)
    }
    _setAttributes(data){
        if(!this._local){
            this._attributes = data;
        }
    }
}