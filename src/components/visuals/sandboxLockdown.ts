/**
 * The first script of every sandboxed visual (p5 sketches and widgets), run
 * before a byte of model-written code: it takes WebRTC away.
 *
 * Each frame's own CSP (`default-src 'none'`) already refuses fetch, XHR,
 * WebSocket, EventSource and every remote load, and the app's enforced
 * `frame-src` (server/app.js) keeps the frame from navigating off this app. No
 * CSP a browser ships covers WebRTC: a peer connection given a STUN or TURN
 * server of the code's choosing sends packets to it while gathering
 * candidates, before anything is connected, and the code can write what it
 * holds into the address or the credentials. No visual has a use for a peer
 * connection, so the constructors are replaced with `undefined` and pinned
 * there (non-writable, non-configurable): a later script cannot put them back.
 *
 * A nested frame would hold fresh copies. One the code only creates is a
 * different opaque origin it cannot reach into, but one it WRITES (`srcdoc`,
 * or markup through `innerHTML`) runs its own script with its own globals. No
 * visual draws in a frame inside its frame, so every frame, object or embed
 * that enters the document is removed before it can load (a mutation observer
 * runs before the nested document's first task), using references taken here,
 * before the code can replace them. Shadow roots, which the observer cannot
 * see into, and document.write/open, which would start the document over, are
 * pinned shut the same way. All measured in Edge (temp/frame-leak/walk.py).
 *
 * The static vetoes on the code itself (server/leavingFrame.js, used by
 * renderP5.ts and `finalizeWidgetHtml`) send an obvious attempt to the repair
 * loop instead; this is what holds when the code spells it some other way.
 */
export const SANDBOX_LOCKDOWN_JS = `(function(){
    var pin=function(o,n,v){try{Object.defineProperty(o,n,{value:v,writable:false,configurable:false,enumerable:false});}catch(e){}};
    var gone=function(){throw new TypeError('not available in a visual');};
    var rtc=['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCIceTransport','RTCSctpTransport','RTCIceCandidate','RTCSessionDescription'];
    for(var i=0;i<rtc.length;i++)pin(window,rtc[i],undefined);
    var apply=Reflect.apply,EP=Element.prototype,get=function(p,n){return Object.getOwnPropertyDescriptor(p,n).get;};
    var tag=get(EP,'tagName'),qsa=EP.querySelectorAll,rm=EP.remove,len=get(NodeList.prototype,'length'),item=NodeList.prototype.item,added=get(MutationRecord.prototype,'addedNodes');
    var FRAMES={IFRAME:1,FRAME:1,FRAMESET:1,OBJECT:1,EMBED:1},SEL='iframe,frame,frameset,object,embed';
    var drop=function(n){try{apply(rm,n,[]);}catch(e){}};
    var sweep=function(n){
        var t;try{t=apply(tag,n,[]);}catch(e){return;}
        if(FRAMES[t]===1){drop(n);return;}
        var l=apply(qsa,n,[SEL]);for(var k=apply(len,l,[])-1;k>=0;k--)drop(apply(item,l,[k]));
    };
    new MutationObserver(function(rs){
        for(var r=0;r<rs.length;r++){var a=apply(added,rs[r],[]);for(var j=apply(len,a,[])-1;j>=0;j--)sweep(apply(item,a,[j]));}
    }).observe(document,{childList:true,subtree:true});
    pin(EP,'attachShadow',gone);pin(EP,'setHTMLUnsafe',gone);
    if(window.ShadowRoot)pin(ShadowRoot.prototype,'setHTMLUnsafe',gone);
    var DP=Document.prototype,w=['write','writeln','open'];
    for(var m=0;m<w.length;m++){pin(DP,w[m],gone);pin(document,w[m],gone);}
    pin(Document,'parseHTMLUnsafe',gone);
})();`;

export { leavesTheFrame } from '../../../server/leavingFrame.js';
