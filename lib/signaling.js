'use strict';

import events       from 'events';
import Logger       from './Logger';


const retry = require('retry');
const logger = new Logger('signaling');


const DEFAULT_RETRY_OPTIONS =
{
	retries    : 10,
	factor     : 1.5,
	minTimeout : 1 * 1000,
	maxTimeout : 5 * 1000
};


export default class SignalingClient extends events.EventEmitter
{
    constructor(options)
    {
        super();
        this.setMaxListeners(Infinity);

        this._token = options.token;
        this._room = options.room;
        this._user = options.user;
        this._wsURL = options.wsURL;

        this._closed = false;

        this._ws = null;

        this._setWebSocket();

    }
    get closed()
    {
        return this._closed;
    }

    sendMessage(message)
    {
        if(this._closed){
            throw new Error('transport closed');
        }

        try {
            this._ws.send(JSON.stringify(message));
        } catch (error) {
             throw new Error('error sending message, ', error);
        }
    }

    close()
    {

        logger.debug('close()');

        if(this._closed)
            return;

        this._closed = true;

        this.emit('close');

		try
		{
			this._ws.onopen = null;
			this._ws.onclose = null;
			this._ws.onerror = null;
			this._ws.onmessage = null;
			this._ws.close();
		}
		catch (error)
		{
			logger.error('close() | error closing the WebSocket: %o', error);
		}

    }
    _setWebSocket()
    {
        const operation = retry.operation(DEFAULT_RETRY_OPTIONS);
        let wasConnected = false;
        let url = this._wsURL + '?token=' + this._token;

        operation.attempt((currentAttempt) => 
        {
            
            if(this._closed)
            {
                operation.stop();
                return;
            }

            logger.debug('connect  currentAttempt ',currentAttempt);

            this._ws = new WebSocket(url);

            this.emit('connecting',currentAttempt);

            this._ws.onopen = () => 
            {
                if(this._closed){
                    return;
                }

                wasConnected = true;

                this.emit('open');
            };

            this._ws.onclose = (event) => 
            {

                logger.debug('onclose');

                if(this._closed){
                    return;
                }

                // Don't retry if code is 4000 (closed by the server).
                if(event.code !== 4000) 
                {
                    if(!wasConnected)
                    {
                        this.emit('failed', currentAttempt);
                        
                        if(operation.retry(true))
                        {
                            return;
                        }
                    } 
                    else 
                    {
                        operation.stop();

                        this.emit('disconnected');   

                        this._setWebSocket(); 
                    }
                }

                this._closed = true;

                this.emit('close');  
            }

            this._ws.onerror = (err) => 
            {

                logger.error('websocket error ', err);
                if(this._closed){
                    return;
                }

               
            } 

            this._ws.onmessage = (event) => 
            {

                if(this._closed){
                    return;
                }

                let msg;
                try {
                    msg = JSON.parse(event.data);
                } catch (err) {
                    logger.error('json parse error', err);
                    return;
                }
                this.emit('message', msg);
                
            }
        })

    }
}
