'use strict';

import events       from 'events';
import Logger       from './Logger';
import io           from 'socket.io-client';


const logger = new Logger('signaling');
export default class SignalingClient extends events.EventEmitter
{
    constructor(url,token)
    {
        super();
        this.setMaxListeners(Infinity);

        this._closed = false;

        this._socket = new io.connect(url,{
            reconnection: true,
            reconnectionDelay: 2000,
            reconnectionDelayMax : 10000,
            reconnectionAttempts: 5,
            query: {
                token: token
            }
        });

        this._socket.on('connect', async () => {
            this.emit('connect')
            this._closed = false;
        })

        this._socket.on('error', () => {
            this.close();
        })

        this._socket.on('disconnect', (reason) => {
            logger.error('disconnect', reason);
            this.close();
        })

        
        this._socket.on('offer', (data, ack) => {
            this.emit('offer', data, ack)
        })

        this._socket.on('peerRemoved', (data) => {
            this.emit('peerRemoved',data);
        })


        this._socket.on('peerConnected', (data) => {
            this.emit('peerConnected',data);
        })

        this._socket.on('configure', (data) => {
            this.emit('configure', data);
        })

        this._socket.on('message', (data) => {
            this.emit('message', data)
        })

    }

    async request(event, data) {
        return new Promise((resolve) => {
            this._socket.emit(event,data, (msg) => {
                resolve(msg)
            })
        })
    }

    close(force)
    {
        
        logger.debug('close()');

        if(this._closed)
            return;

        this._closed = true;

        if (force) {
            this._socket.close()
        }

        this.emit('close');

    }

}
