


export default class ViewManager
{
    constructor(options)
    {
        this._options = undefined === options ? {} : options;
        this._container = document.createElement('div');
        let video = document.createElement('video');
        this._container.appendChild(video);
        this._container.id = options.id;
        this._container.width = options.width || 320;
        this._container.height = options.height || 240;
        video.setAttribute('controls', true);
        video.setAttribute('playsinline', true);
        video.setAttribute('autoplay', true);
        this._video = video;
        this._scaleMode = ViewManager.ScaleModeFill;
        this._mirror = true;

        this._updateLayout();
    }
    get video()
    {
        return this._video;
    }
    get view()
    {
        return this._container;
    }
    set mirror(isMirror)
    {
        if(isMirror){
            this._mirror = isMirror
        } else {
            this._mirror = false;
        }

        this._updateLayout();
    }
    set scaleMode(scaleMode)
    {
        this._scaleMode = scaleMode;
        this._updateLayout()
    }
    set stream(stream)
    {
        this._video.srcObject = stream.mediastream;
        if(stream.isLocal){
            this._video.volume = 0.0;
        } else {
            this._video.volume = 1.0;
        }

        this.id = stream.streamId;
        this._video.srcObject = stream.mediastream;
        this._video.play();
    }
    snapshot()
    {
        if(!this._video){
            return
        }
        if(this._video.ended){
            return
        }
        let canvas_ = document.createElement('canvas');
        canvas_.width = this._video.width;
        canvas_.height = this._video.height;

        let context = canvas_.getContext('2d');
        context.drawImage(this._video, 0, 0, canvas_.width,
                    canvas_.height);

        return context.getImageData(0, 0, canvas_.width, canvas_.height);
    }
    _updateLayout()
    {
        let mirrorcss = "";
        if(this._mirror){
            mirrorcss  = "-moz-transform: scale(-1, 1); \
                         -webkit-transform: scale(-1, 1); \
                         -o-transform: scale(-1, 1); \
                         transform: scale(-1, 1); filter: FlipH;";
        }

        let scalecss = "";
        if(this._scaleMode === ViewManager.ScaleModeFill)
        {
            scalecss = "object-fit: cover;";
        } else {
            scalecss = "object-fit: cover;";
        }
        let videocss = mirrorcss + scalecss;
        this._video.style.cssText = videocss;
    }
    
}

ViewManager.ScaleModeFit = 0;
ViewManager.ScaleModeFill = 1;