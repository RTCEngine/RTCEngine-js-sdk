'use strict';

import bowser from 'bowser'
import Logger from './Logger'

const logger = new Logger('device')


export default  class DeviceManager
{

    static get flag()
    {
        if(!DeviceManager._detected){
            DeviceManager._detect()
        }
        return DeviceManager._flag
    }
    static get name()
    {
        if(!DeviceManager._detected){
            DeviceManager._detect()
        }
        return DeviceManager._name
    }
    static get version()
    {
        if(!DeviceManager._detected){
            DeviceManager._detect()
        }
        return DeviceManager._version
    }
    static get browser() 
    {
        if(!DeviceManager._detected){
            DeviceManager._detect()
        }
        return DeviceManager._browser
    }
    static _detect()
    {
        const ua = global.navigator.userAgent
        const browser = bowser._detect(ua)

        DeviceManager._detected = true 
        DeviceManager._flag = undefined
        DeviceManager._name = browser.name || 'unknow browser'
        DeviceManager._version = browser.version || 'unknow version'
        DeviceManager._browser = browser
        DeviceManager._supported = false 

        // Chrome, Chromium (desktop and mobile).
		if (bowser.check({ chrome: '55' }, true, ua))
		{
			DeviceManager._flag = 'chrome'
            DeviceManager._supported = true
		}
		// Firefox (desktop and mobile).
		else if (bowser.check({ firefox: '50' }, true, ua))
		{
			DeviceManager._flag = 'firefox'
            DeviceManager._supported = true
		}
		// Safari (desktop and mobile).
		else if (bowser.check({ safari: '11' }, true, ua))
		{
			DeviceManager._flag = 'safari'
            DeviceManager._supported = true
		}
		// Edge (desktop).
		else if (bowser.check({ msedge: '11' }, true, ua))
		{
			DeviceManager._flag = 'msedge'
            DeviceManager._supported = true
		}
		// Opera (desktop and mobile).
		if (bowser.check({ opera: '44' }, true, ua))
		{
			DeviceManager._flag = 'opera'
            DeviceManager._supported = true
		}

		if (DeviceManager.isSupported())
		{
			logger.debug(
				'device supported [flag:%s, name:"%s", version:%s',
				DeviceManager._flag, DeviceManager._name, DeviceManager._version);
		}
		else
		{
			logger.warn(
				'device not supported [name:%s, version:%s]',
				DeviceManager._name, DeviceManager._version);
        }
    }

    static isSupported()
	{
		if (!DeviceManager._detected)
			DeviceManager._detect();

		return DeviceManager._supported;
	}

    static getDevices()
    {
        
        return Promise.resolve()
                .then(() => {
                    return navigator.mediaDevices.enumerateDevices()
                })
                .then((devices) => {

                    for(let i=0; i < devices.length; i++){
                        let deviceInfo = devices[i]
                        if(deviceInfo.kind === 'audioinput'){
                            DeviceManager.audioInputs.set(deviceInfo.deviceId,deviceInfo)
                        }
                        if(deviceInfo.kind === 'audiooutput'){
                            DeviceManager.audioOutputs.set(deviceInfo.deviceId,deviceInfo)
                        }
                        if(deviceInfo.kind === 'videoinput'){
                            DeviceManager.videoInputs.set(deviceInfo.deviceId,deviceInfo)
                        }
                    }

                })
    }
    
}


DeviceManager._detected = false;

DeviceManager._flag = undefined;

DeviceManager._name = undefined;

DeviceManager._version = undefined;

DeviceManager._browser = undefined;

DeviceManager._supported = false;

DeviceManager.audioInputs = new Map();

DeviceManager.audioOutputs = new Map();

DeviceManager.videoInputs = new Map();






