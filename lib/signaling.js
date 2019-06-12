'use strict';

import events       from 'events';
import Logger       from './Logger';
import io           from 'socket.io-client';

const logger = new Logger('signaling');

export default class SignalingClient extends events.EventEmitter
{
    constructor(url, options)
    {
        super();
        this.setMaxListeners(Infinity);

        this._closed = false;

        this._socket = new io.connect(url,{
            reconnection: true,
            reconnectionDelay: 1000,
            reconnectionDelayMax : 10000,
            reconnectionAttempts: 5,
            query: {
                room: options && options.room
            }
        });

        this._socket.on('connect', async () => {
            this.emit('connect')
            this._closed = false;
        })

        this._socket.on('disconnect', (reason) => {
            logger.error('disconnect', reason);
            this.emit('disconnect')
            this.close();
        })

        this._socket.on('message', (data) => {
            this.emit('message', data)
        })

        this._socket.on('streamadded', (data) => {
            this.emit('streamadded', data);
        })

        this._socket.on('streamremoved', (data) => {
            this.emit('streamremoved', data);
        })
    }

    async send(event, data) {
        return new Promise((resolve) => {
            this._socket.emit(event,data, (msg) => {
                resolve(msg)
            })
        })
    }

    close()
    {
        
        logger.debug('close()');

        if(this._closed)
            return;

        this._closed = true;

        this._socket.close();
        
        this._socket = null;

        this.emit('close');

    }

}
