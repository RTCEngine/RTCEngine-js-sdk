'use strict';

import io           from 'socket.io-client';
import events       from 'events';
import Logger       from './Logger';

const logger = new Logger('socketio-signaling')

export default class SocketIOSignalingClient extends events.EventEmitter 
{
    constructor(options)
    {
        super()
        this.setMaxListeners(Infinity)

        this._socket = undefined;
        this._token = options.token;
        this._room = options.room;
        this._user = options.user;
        this._wsURL = options.wsURL;
        this._appkey = options.appkey;

    }
    connect()
    {
        let that = this;
        let url = this._wsURL + '?token=' + this._token;

        if(this._socket && this._socket.connected){
            return
        }

        this._socket = new io.connect(url,{
            'reconnection': true,
            'reconnectionDelay': 2000,
            'reconnectionDelayMax' : 3000,
            'reconnectionAttempts': 5
        });

        this._socket.on('connect', () => {
            that.emit('connect', {});
            logger.debug('connect ');
        })

        this._socket.on('error', (err) => {
            logger.error('error ', err)
            that.disconnect()
        })


        this._socket.on('disconnect', (reason) => {
            logger.error('ondisconnect ', reason)
            that._disconenct()
        })

        this._socket.on('reconnect', (attemptNumber) => {
            logger.error('reconnect ', 'attemptNumber ', attemptNumber)
            that.emit('reconnect', attemptNumber)
        })
        
        this._socket.on('reconnect_failed', () => {
            logger.error('reconnect_failed')
            this._socket.destroy()
            that.disconnect()
        })

        this._socket.on('message', (msg, callback) => {
            that.emit('message', msg, callback)
        })
    }
    disconnect()
    {
        if(!this._socket){
            return
        }
        if(this._socket.connected){
            logger.error('realy call disconnect')
            this._socket.disconnect()
            return
        }
    }
    sendMessage(message)
    {
        this._socket.emit('message',message)
    }
    _disconenct()
    {
        logger.error('realy emit  disconnect')
        this.emit('disconnect',{})
    }

}
