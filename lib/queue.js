'use strict';

export default class ExecutingQueue 
{
    constructor() 
    {
        this.pending = [];
        this.executing = false;
    }

    async push(execute) 
    {
        this.pending.push(execute);

        if (this.executing) {
            return;
        }
        
        this.executing = true;

        while(this.pending.length) {
            await this.pending.shift()();
        }
        this.executing = false;
    }
}
