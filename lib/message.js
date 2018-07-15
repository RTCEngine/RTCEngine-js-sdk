'use strict'


class Message
{
    static parse(raw)
    {
        let object;
        let message = {};

        object = JSON.parse(raw);

        message.id  = object.id;
        message.type = object.type;
        message.from = object.from;
        message.target = object.target;
        message.data = object.data || {};
        return message;
    }
    static messageFactory(from,type,target,data)
    {
        let message = {};
        message.from = from;
        message.type = type;
        message.target = target;
        message.data = data;
        return message;
        
    }
}


export default  Message;