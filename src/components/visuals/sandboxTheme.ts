import type { VisualPalette } from './palette';

/**
 * The colour rule from `palette.ts`, as source text, for the sandboxes.
 *
 * A ```p5 sketch runs in an opaque-origin iframe (`allow-scripts`, no
 * `allow-same-origin`) under `default-src 'none'`: it cannot import a module,
 * fetch one, or reach this document. So the one place the rule is genuinely
 * needed at run time — inside a sketch's own `background()`/`fill()`/`stroke()`
 * calls, whose arguments are computed per frame and cannot be pre-mapped — is
 * the one place the module cannot go.
 *
 * Hence a twin, kept honest rather than kept in sync by hand:
 * `tools/visual-theme-gates.mjs` bundles BOTH and drives them over one table of
 * inputs across all four themes. The comparison is the contract; if they drift,
 * the gate fails rather than a sketch quietly picking the wrong grey.
 *
 * Kept deliberately small — it is injected into every sketch document, so it is
 * the achromatic/chromatic split and nothing else. A sketch declares its own
 * backdrop by calling background(), which is passed in as `assumedBg`: it is
 * what tells a light-on-dark sketch apart from a dark-on-light one. Anything richer (series
 * palettes, SVG walking) stays in the module, where it belongs.
 */
export const SANDBOX_THEME_JS = `
var __VT_NAMED = {black:'#000000',white:'#ffffff',red:'#ff0000',green:'#008000',blue:'#0000ff',yellow:'#ffff00',orange:'#ffa500',purple:'#800080',gray:'#808080',grey:'#808080',silver:'#c0c0c0',lime:'#00ff00',cyan:'#00ffff',aqua:'#00ffff',magenta:'#ff00ff',fuchsia:'#ff00ff',navy:'#000080',teal:'#008080',olive:'#808000',maroon:'#800000',pink:'#ffc0cb',brown:'#a52a2a',gold:'#ffd700',darkgray:'#a9a9a9',darkgrey:'#a9a9a9',lightgray:'#d3d3d3',lightgrey:'#d3d3d3'};
function __vtClamp(n){return n<0?0:n>1?1:n;}
function __vtHex2(n){var s=Math.round(__vtClamp(n)*255).toString(16);return s.length<2?'0'+s:s;}
function __vtToHex(c){return '#'+__vtHex2(c.r)+__vtHex2(c.g)+__vtHex2(c.b);}
function __vtParse(raw){
    if(raw===null||raw===undefined)return null;
    var s=String(raw).trim().toLowerCase();
    if(!s||s==='none'||s==='transparent'||s==='currentcolor'||s==='inherit')return null;
    if(s.indexOf('url(')===0||s.indexOf('var(')===0)return null;
    var t=__VT_NAMED[s]||s;
    if(t.charAt(0)==='#'){
        var h=t.slice(1),n;
        if(h.length===3||h.length===4){
            n=parseInt(h.slice(0,3),16);
            if(isNaN(n))return null;
            return {r:((n>>8&15)*17)/255,g:((n>>4&15)*17)/255,b:((n&15)*17)/255};
        }
        if(h.length===6||h.length===8){
            n=parseInt(h.slice(0,6),16);
            if(isNaN(n))return null;
            return {r:(n>>16&255)/255,g:(n>>8&255)/255,b:(n&255)/255};
        }
        return null;
    }
    var parts=t.replace(/^rgba?\\(/,'').replace(/\\)$/,'').split(/[\\s,\\/]+/).filter(Boolean).map(Number);
    if(parts.length>=3&&isFinite(parts[0])&&isFinite(parts[1])&&isFinite(parts[2])){
        return {r:parts[0]/255,g:parts[1]/255,b:parts[2]/255};
    }
    return null;
}
function __vtLum(c){
    function l(v){return v<=0.04045?v/12.92:Math.pow((v+0.055)/1.055,2.4);}
    return 0.2126*l(c.r)+0.7152*l(c.g)+0.0722*l(c.b);
}
function __vtRatio(a,b){var x=__vtLum(a),y=__vtLum(b);return (Math.max(x,y)+0.05)/(Math.min(x,y)+0.05);}
function __vtHsl(c){
    var max=Math.max(c.r,c.g,c.b),min=Math.min(c.r,c.g,c.b),l=(max+min)/2,d=max-min;
    if(d===0)return {h:0,s:0,l:l};
    var s=d/(1-Math.abs(2*l-1)),h;
    if(max===c.r)h=((c.g-c.b)/d)%6; else if(max===c.g)h=(c.b-c.r)/d+2; else h=(c.r-c.g)/d+4;
    return {h:(h*60+360)%360,s:s,l:l};
}
function __vtRgb(h,s,l){
    var c=(1-Math.abs(2*l-1))*s,x=c*(1-Math.abs((h/60)%2-1)),m=l-c/2,t;
    if(h<60)t=[c,x,0]; else if(h<120)t=[x,c,0]; else if(h<180)t=[0,c,x];
    else if(h<240)t=[0,x,c]; else if(h<300)t=[x,0,c]; else t=[c,0,x];
    return {r:__vtClamp(t[0]+m),g:__vtClamp(t[1]+m),b:__vtClamp(t[2]+m)};
}
function __vtContrast(color,bg,min){
    if(__vtRatio(color,bg)>=min)return color;
    var hsl=__vtHsl(color),dir=__vtLum(bg)<0.5?1:-1,best=color,bestR=__vtRatio(color,bg);
    for(var i=1;i<=40;i++){
        var next=__vtRgb(hsl.h,hsl.s,__vtClamp(hsl.l+dir*i*0.02)),r=__vtRatio(next,bg);
        if(r>bestR){best=next;bestR=r;}
        if(r>=min)return next;
    }
    return best;
}
function __vtAdapt(raw,palette,role,assumedBg){
    var rgb=__vtParse(raw);
    if(!rgb)return null;
    var bg=__vtParse(palette.bg)||{r:1,g:1,b:1};
    var chroma=Math.max(rgb.r,rgb.g,rgb.b)-Math.min(rgb.r,rgb.g,rgb.b);
    if(chroma<0.16){
        var against=__vtParse(assumedBg||'#ffffff')||{r:1,g:1,b:1};
        var emphasis=__vtRatio(rgb,against);
        if(emphasis<1.6)return role==='fill'?palette.bg:palette.border;
        if(emphasis>=7)return palette.fg;
        if(emphasis>=3)return palette.muted;
        return palette.border;
    }
    return __vtToHex(__vtContrast(rgb,bg,role==='text'?4.5:3));
}
`;

/**
 * Theme bridge for a sketch.
 *
 * ```p5 was the one visual kind with no theme handling at all, and the guide
 * (plus every example in it) tells the model to open draw() with a literal
 * `background(17, 24, 39)`. So every sketch in this app was dark-only: on a
 * light or warm theme it arrived as a slab of near-black inside a white card,
 * and `legend()`'s own slate-200 label text — hardcoded right here — was
 * unreadable the moment anyone gave the canvas a light background.
 *
 * The sketch cannot be rewritten (it is model-authored, cached, and its colours
 * are computed per frame), so p5's colour entry points are wrapped instead:
 * every value passed to background/fill/stroke goes through the same rule the
 * rest of the app uses (sandboxTheme.ts, the checked twin of palette.ts).
 *
 * `background()` is special twice over: it becomes this theme's surface, AND
 * the colour the author asked for is recorded as the backdrop everything else
 * in the frame is judged against. That is what tells a sketch drawn
 * light-on-dark from one drawn dark-on-light — without it, a legend written in
 * slate-200 for a near-black canvas would be read as "very pale, therefore
 * faint" and demoted to a hairline on every theme.
 *
 * A p5.Color object or any argument shape this does not understand is passed
 * through untouched: this may make a sketch visible, never change what it draws.
 */
export function p5ThemePrelude(p: VisualPalette): string {
    return `${SANDBOX_THEME_JS}
var __vtPalette = ${JSON.stringify({ bg: p.bg, fg: p.fg, muted: p.muted, border: p.border })};
// Paper until the sketch says otherwise; draw()'s first line must be a
// background() call (renderP5 refuses a sketch without one), so by the time
// anything is drawn this holds the canvas the author actually had in mind.
var __vtAssumed = '#ffffff';
(function () {
    function toCss(args) {
        if (args.length === 0) return null;
        if (args.length === 1 && typeof args[0] === 'string') return args[0];
        var nums = [];
        for (var i = 0; i < args.length && i < 4; i++) {
            if (typeof args[i] !== 'number' || !isFinite(args[i])) return null;
            nums.push(args[i]);
        }
        // p5 grayscale: background(g) / background(g, a).
        if (nums.length === 1) return 'rgb(' + nums[0] + ',' + nums[0] + ',' + nums[0] + ')';
        if (nums.length === 2) return 'rgb(' + nums[0] + ',' + nums[0] + ',' + nums[0] + ')';
        return 'rgb(' + nums[0] + ',' + nums[1] + ',' + nums[2] + ')';
    }
    // The alpha the author passed, so a translucent trail stays translucent.
    function alphaOf(args) {
        if (args.length === 2 && typeof args[1] === 'number') return args[1];
        if (args.length === 4 && typeof args[3] === 'number') return args[3];
        return null;
    }
    // The canvas colour itself. An achromatic backdrop is "the page" and becomes
    // this theme's surface; a CHROMATIC one (a sky, a petri dish, a board) was a
    // deliberate part of the picture and is kept exactly — the sketch is then
    // self-consistent, because everything drawn on it is judged against it.
    function themeBackground(css) {
        var rgb = __vtParse(css);
        if (!rgb) return null;
        var chroma = Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b);
        return chroma < 0.16 ? __vtPalette.bg : css;
    }
    // WHERE to wrap, and it is not window. p5 copies its drawing functions onto
    // window inside the p5 constructor, which runs on the load event — after
    // this script has already executed — so wrapping window here would silently
    // no-op and the theming would do nothing at all. p5.prototype is populated
    // by the time p5.min.js has finished parsing (it is loaded synchronously in
    // <head>), and the global copies are taken FROM it, so wrapping there
    // catches both the globals and any call made during setup(). The window
    // fallback is for a p5 build that does not expose the constructor.
    var proto = (window.p5 && window.p5.prototype) || window;
    function apply(name, role) {
        var orig = proto[name];
        if (typeof orig !== 'function') return;
        proto[name] = function () {
            var css = toCss(arguments);
            if (css === null) return orig.apply(this, arguments);
            var next;
            if (name === 'background') {
                __vtAssumed = css;
                next = themeBackground(css);
            } else {
                next = __vtAdapt(css, __vtPalette, role, __vtAssumed);
            }
            if (!next) return orig.apply(this, arguments);
            var rgb = __vtParse(next);
            if (!rgb) return orig.apply(this, arguments);
            var a = alphaOf(arguments);
            var r = Math.round(rgb.r * 255), g = Math.round(rgb.g * 255), b = Math.round(rgb.b * 255);
            return a === null ? orig.call(this, r, g, b) : orig.call(this, r, g, b, a);
        };
    }
    apply('background', 'fill');
    apply('fill', 'fill');
    apply('stroke', 'stroke');
})();`;
}
