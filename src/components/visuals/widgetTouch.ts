/**
 * A widget on a phone — the half the HOST can do for a build it did not write.
 *
 * Most widgets are read on a phone, and the compiler wrote them for a mouse: a
 * drag listens for `mousedown`/`mousemove`, which a finger never sends while it
 * moves, and the finger scrolls the page instead; native controls keep their
 * desktop size (a 16px slider, a 25px button). The compiler's prompt now asks
 * for Pointer Events, `touch-action` and 44px controls, but a prompt reaches
 * only the builds made after it, and every cached build is still mouse-only.
 * Both of these go into the head `buildWidgetDoc` writes, so they reach every
 * build at render time with no rebuild (and `WIDGET_CONTRACT_VERSION` stays).
 *
 * Measured in Edge at 390px with touch on a hand-written mouse-only widget:
 * before, a sideways drag on its canvas left the value where it was and a
 * vertical one scrolled the page; the slider was 16px tall, the button 25px.
 */

/**
 * Everything here is under a coarse pointer, so a desktop widget is unchanged.
 * `min-height` rather than `height`: it outranks a build's own `height` and
 * leaves a taller control alone. Only a button with something in it grows, and
 * only in height: an empty one is a colour swatch or a hotspot over a canvas,
 * where 44px would push them into each other, and a width of 44 would push a
 * row of small buttons (digits, steps) past a 360px frame, which a cached
 * build does not wrap. A slider is grown by the script below, because the right
 * way depends on the build's styles. Pictures are held to the frame; a canvas
 * is not, since a build maps a press from `clientX` against its drawing buffer
 * and a squeezed canvas would put every press in the wrong place.
 */
export const WIDGET_TOUCH_CSS =
    '@media (pointer:coarse){'
    + 'button:not(:empty),select,textarea,input:not([type=checkbox]):not([type=radio]):not([type=range]):not([type=hidden]){min-height:44px;}'
    + 'input[type=checkbox],input[type=radio]{min-width:24px;min-height:24px;}'
    + 'img,video{max-width:100%;height:auto;}'
    + '}';

/**
 * Sandbox source text (it runs under `default-src 'none'` and imports nothing),
 * and it must run BEFORE the build's script so it sees every listener added.
 * It records listeners as they are added (and the `onmousedown="…"` kind the
 * parser sets, read off the markup), and decides once the document has loaded
 * and again when the build adds or reveals content, because only then do the
 * elements, their children and the build's styles exist. On a device with no
 * touch screen it decides nothing until a finger or pen first touches it.
 *
 * 1. What a finger may drag gets `touch-action: none`, and nothing else does,
 *    so a thumb anywhere else still scrolls. For an element with a `mousedown`
 *    or `pointerdown` listener, the surface is the element itself when it is a
 *    canvas, an svg, a leaf (a handle; a shape inside an svg claims its svg) or
 *    sets a grab, move or resize cursor of its own (a slider built of divs; an
 *    inherited one, such as a body set to `grabbing` mid-drag, does not
 *    count); for any other wrapper, or the document, it is the canvases and
 *    svgs inside. A surface whose `touch-action` the build set, a scroll
 *    container, the page, the body, native controls and anything inside a
 *    button or link (an icon) are left alone. Only in a build that drags at all
 *    (some `mousemove`/`pointermove`/`touchmove` listener): a list that selects
 *    on `mousedown` is not a drag. A mouse-only build that adds its move
 *    listener INSIDE its `mousedown` has none until the first press, too late
 *    for `touch-action`, which the browser reads as the finger lands; so until
 *    then a canvas, svg or grab-cursor surface holds its `touchmove` instead,
 *    but only while a replayed drag is under way and some move listener
 *    exists, so a press that is only a press still scrolls. (A held surface
 *    makes the browser wait on this page before it scrolls from there, so a
 *    plain leaf is not held, and the hold goes once `touch-action` is set.)
 *    A pointer-handling build that does the same is not covered: it was told
 *    to set `touch-action` itself.
 * 2. A build that handles only the MOUSE gets the finger as a mouse: a touch
 *    or pen pointer that goes down on an element with a `mousedown` listener on
 *    its way up (or on window), in a document that listens for no pointer or
 *    touch event on that way or on window, becomes `mousemove` (no button: a
 *    mouse moves to a place before it presses there; no `mouseover` is sent)
 *    then `mousedown`/`mousemove`/`mouseup`.
 *    Its `pointerdown` is cancelled, which stops the browser's own
 *    compatibility mouse events (no double `mousedown` on a tap) and keeps the
 *    `click`. A cancelled pointer ends the drag where it last was; a new finger
 *    ends one whose lift was lost. A build that handles pointers or touches
 *    itself is left to do so, including one listening for them on window only.
 * 3. A slider is grown to 44px: a native one takes `min-height` and draws its
 *    track in the middle, but a build that restyled it (`appearance: none`,
 *    its background IS the track) would draw a 44px slab, so that one gets
 *    transparent padding with its background clipped to the content box. A
 *    hidden slider (a closed tab) is grown when it is shown, however the build
 *    shows it: a slider with no size yet is watched until it has one.
 *
 * Elements are held by weak reference, so one the build throws away is freed
 * (a build that redraws its controls every frame would otherwise keep every
 * copy alive, on a desktop too, where nothing is decided), and one it puts
 * back is still known. On a screen that reports touch only at the first
 * finger, that first press is replayed but has no `touch-action` yet.
 */
export const WIDGET_TOUCH_JS = `(function(){
    var P=EventTarget.prototype,add=P.addEventListener,seen=new WeakMap();
    var START={mousedown:1,pointerdown:1},MOVE={mousemove:1,pointermove:1,touchmove:1};
    var OWN=/^(?:html|body|input|select|textarea|button|label|a|option)$/i,IN_OWN='button,a';
    var FINGER=['pointerdown','pointermove','pointerup','touchstart','touchmove','touchend'];
    var KINDS=['mousedown','mousemove','pointerdown','pointermove','pointerup','touchstart','touchmove','touchend'];
    function touchy(){return (navigator.maxTouchPoints||0)>0||!!(window.matchMedia&&matchMedia('(any-pointer:coarse)').matches);}
    var ref=window.WeakRef?function(t){return new WeakRef(t);}:function(t){return {deref:function(){return t;}};};
    var starters=[],cap=64,listed=new WeakSet(),moves=false,claimed=new WeakSet(),held=new WeakSet(),grown=new WeakSet(),loaded=false,queued=0;
    function compact(){starters=starters.filter(function(r){return !!r.deref();});cap=Math.max(64,starters.length*2);}
    function note(t,type){
        var s=seen.get(t);if(!s){s={};seen.set(t,s);}
        if(s[type])return;
        s[type]=1;
        if(START[type]&&!listed.has(t)){listed.add(t);starters.push(ref(t));if(starters.length>cap)compact();}
        if(MOVE[type])moves=true;
        if(loaded)later();
    }
    P.addEventListener=function(type,fn,opts){try{if(this)note(this,String(type));}catch(e){}return add.call(this,type,fn,opts);};
    [window.HTMLElement&&HTMLElement.prototype,window.SVGElement&&SVGElement.prototype,window.Document&&Document.prototype,
     window.Window&&Window.prototype,window].forEach(function(o){
        if(!o)return;
        KINDS.forEach(function(k){
            var p='on'+k,d=Object.getOwnPropertyDescriptor(o,p);
            if(!d||!d.set||!d.configurable)return;
            Object.defineProperty(o,p,{configurable:true,enumerable:d.enumerable,get:d.get,
                set:function(v){try{if(v)note(this,k);}catch(e){}d.set.call(this,v);}});
        });
    });
    function has(t,types){var s=seen.get(t);if(!s)return false;for(var i=0;i<types.length;i++)if(s[types[i]])return true;return false;}
    function inline(){
        var l=document.querySelectorAll(KINDS.map(function(k){return '[on'+k+']';}).join(','));
        for(var i=0;i<l.length;i++)for(var j=0;j<KINDS.length;j++)if(l[i].hasAttribute('on'+KINDS[j]))note(l[i],KINDS[j]);
    }
    function usable(el){
        if(!el||el.nodeType!==1||!el.isConnected||OWN.test(el.localName))return false;
        if(el.parentElement&&el.parentElement.closest(IN_OWN))return false;
        var cs=getComputedStyle(el);
        if(cs.touchAction&&cs.touchAction!=='auto')return false;
        return el.localName==='canvas'||!/auto|scroll/.test(cs.overflow+' '+cs.overflowX+' '+cs.overflowY);
    }
    function hold(e){if(drag&&moves&&e.cancelable)e.preventDefault();}
    function surface(el,holdable){
        // The hold goes after the drag that made it unneeded: touch-action set
        // mid-gesture does not apply to that gesture.
        if(claimed.has(el)){unhold(el);return;}
        if(!usable(el))return;
        if(moves){claimed.add(el);el.style.touchAction='none';unhold(el);}
        else if(holdable&&!held.has(el)){held.add(el);add.call(el,'touchmove',hold,{passive:false});}
    }
    function unhold(el){if(held.has(el)&&!drag){held.delete(el);el.removeEventListener('touchmove',hold,{passive:false});}}
    function grabby(el){
        var c=getComputedStyle(el).cursor,p=el.parentElement;
        return /grab|move|resize/.test(c)&&(!p||getComputedStyle(p).cursor!==c);
    }
    function topSvg(el){while(el.ownerSVGElement)el=el.ownerSVGElement;return el;}
    function inside(root){
        var l=root.querySelectorAll('canvas,svg');
        for(var i=0;i<l.length;i++)if(l[i].localName==='canvas'||!l[i].ownerSVGElement)surface(l[i],true);
    }
    function claimOne(t){
        if(t===window||t.nodeType===9){inside(document);return;}
        if(t.nodeType!==1||!t.isConnected)return;
        if(/^(?:html|body)$/i.test(t.localName))inside(document);
        else if(OWN.test(t.localName))return;
        else if(t.ownerSVGElement)surface(topSvg(t),true);
        else if(t.localName==='canvas'||t.localName==='svg'||grabby(t))surface(t,true);
        else if(!t.firstElementChild)surface(t,false);
        else inside(t);
    }
    function claim(){
        var keep=[];
        for(var i=0;i<starters.length;i++){
            var t=starters[i].deref();
            if(!t)continue;
            keep.push(starters[i]);
            try{claimOne(t);}catch(e){}
        }
        starters=keep;
    }
    // Text written into a readout is not news; an element added or a class,
    // hidden or open changed may be (a canvas drawn, a tab shown).
    function changed(records){
        for(var i=0;i<records.length;i++){
            if(records[i].type==='attributes'){later();return;}
            var a=records[i].addedNodes;
            for(var j=0;j<a.length;j++)if(a[j].nodeType===1){later();return;}
        }
    }
    var sized=window.ResizeObserver?new ResizeObserver(function(){later();}):null,watched=new WeakSet();
    function sliders(){
        if(!window.matchMedia||!matchMedia('(pointer:coarse)').matches)return;
        var list=document.querySelectorAll('input[type=range]');
        for(var i=0;i<list.length;i++){
            var el=list[i];if(grown.has(el))continue;
            var h=el.getBoundingClientRect().height;
            if(!h){if(sized&&!watched.has(el)){watched.add(el);sized.observe(el);}continue;}
            grown.add(el);if(sized&&watched.has(el))sized.unobserve(el);
            if(h>=44)continue;
            var cs=getComputedStyle(el);
            if((cs.getPropertyValue('appearance')||cs.getPropertyValue('-webkit-appearance'))!=='none'){el.style.minHeight='44px';continue;}
            var top=parseFloat(cs.paddingTop)||0,bottom=parseFloat(cs.paddingBottom)||0,extra=(44-h)/2;
            el.style.boxSizing='content-box';
            el.style.height=Math.max(0,el.clientHeight-top-bottom)+'px';
            el.style.paddingTop=(top+extra)+'px';
            el.style.paddingBottom=(bottom+extra)+'px';
            el.style.backgroundClip='content-box';
        }
    }
    function pass(){queued=0;[inline,claim,sliders].forEach(function(f){try{f();}catch(e){}});}
    function later(){if(!queued)queued=setTimeout(pass,50);}
    function start(){
        if(loaded)return;
        // Read the markup's handlers now: the press that started this asks next.
        try{inline();}catch(e){}
        loaded=true;setTimeout(pass,0);
        if(window.MutationObserver&&document.body)new MutationObserver(changed).observe(document.body,
            {childList:true,subtree:true,attributes:true,attributeFilter:['class','hidden','open']});
    }
    add.call(window,'load',function(){if(touchy())start();});
    function mouseOnly(el){
        var mouse=has(window,['mousedown']);
        for(var n=el;n;n=n.parentNode){
            if(n.nodeType===1&&OWN.test(n.localName)&&n.localName!=='html'&&n.localName!=='body')return false;
            if(has(n,FINGER))return false;
            if(has(n,['mousedown']))mouse=true;
        }
        return mouse&&!has(window,FINGER);
    }
    var drag=null;
    function fire(type,buttons,e,x,y,sx,sy){
        var at=type==='mousedown'?drag.target:(document.elementFromPoint&&document.elementFromPoint(x,y))||drag.target;
        if(!at.isConnected)at=document;
        var mx=x-drag.x,my=y-drag.y;drag.x=x;drag.y=y;drag.sx=sx;drag.sy=sy;
        at.dispatchEvent(new MouseEvent(type,{bubbles:true,cancelable:true,composed:true,view:window,
            clientX:x,clientY:y,screenX:sx,screenY:sy,movementX:mx,movementY:my,
            button:0,buttons:buttons,ctrlKey:!!e.ctrlKey,shiftKey:!!e.shiftKey,altKey:!!e.altKey,metaKey:!!e.metaKey}));
    }
    function finish(e){
        try{
            if(e)fire('mouseup',0,e,e.clientX,e.clientY,e.screenX,e.screenY);
            else fire('mouseup',0,{},drag.x,drag.y,drag.sx,drag.sy);
        }finally{drag=null;if(loaded)later();}
    }
    add.call(window,'pointerdown',function(e){
        try{
            if(e.pointerType==='mouse'||!e.isPrimary)return;
            if(document.readyState==='complete')start();
            if(drag)finish(null);
            var t=e.target;if(!t||t.nodeType!==1||!mouseOnly(t))return;
            e.preventDefault();
            drag={id:e.pointerId,target:t,x:e.clientX,y:e.clientY,sx:e.screenX,sy:e.screenY};
            fire('mousemove',0,e,e.clientX,e.clientY,e.screenX,e.screenY);
            fire('mousedown',1,e,e.clientX,e.clientY,e.screenX,e.screenY);
        }catch(err){}
    },true);
    add.call(window,'pointermove',function(e){try{if(drag&&e.pointerId===drag.id)fire('mousemove',1,e,e.clientX,e.clientY,e.screenX,e.screenY);}catch(err){}},true);
    add.call(window,'pointerup',function(e){try{if(drag&&e.pointerId===drag.id)finish(e);}catch(err){}},true);
    add.call(window,'pointercancel',function(e){try{if(drag&&e.pointerId===drag.id)finish(null);}catch(err){}},true);
})();`;
