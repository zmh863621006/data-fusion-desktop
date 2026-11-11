export const graphicsExpression = String.raw`(() => {
  const canvas = document.createElement('canvas'); canvas.width=16;canvas.height=16;
  const two = canvas.getContext('2d');two.fillStyle='rgb(51,153,204)';two.fillRect(0,0,16,16);
  const canvasPixel=[...two.getImageData(8,8,1,1).data];
  function webgl(type) {
    const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;
    const gl=canvas.getContext(type,{preserveDrawingBuffer:true,antialias:false});
    if(!gl)return {type,supported:false};
    const extension=gl.getExtension('WEBGL_debug_renderer_info');
    const renderer=extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER);
    const version=gl.getParameter(gl.VERSION);
    const v=type==='webgl2'?'#version 300 es\nin vec2 p;void main(){gl_Position=vec4(p,0.,1.);}':'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}';
    const f=type==='webgl2'?'#version 300 es\nprecision mediump float;out vec4 color;void main(){color=vec4(0.2,0.6,0.8,1.);}':'precision mediump float;void main(){gl_FragColor=vec4(0.2,0.6,0.8,1.);}';
    const shader=(kind,source)=>{const shader=gl.createShader(kind);gl.shaderSource(shader,source);gl.compileShader(shader);if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(shader));return shader;};
    const program=gl.createProgram();gl.attachShader(program,shader(gl.VERTEX_SHADER,v));gl.attachShader(program,shader(gl.FRAGMENT_SHADER,f));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const position=gl.getAttribLocation(program,'p');gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
    gl.viewport(0,0,16,16);gl.drawArrays(gl.TRIANGLES,0,3);gl.finish();const pixel=new Uint8Array(4);gl.readPixels(8,8,1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);
    const error=gl.getError(),correct=pixel.every((value,index)=>Math.abs(value-[51,153,204,255][index])<=1);
    window.__d3dDiagnosticContexts??=[];window.__d3dDiagnosticContexts.push(gl);
    return {type,supported:true,renderer,version,pixel:[...pixel],shaderDrawPassed:correct&&error===gl.NO_ERROR,error};
  }
  return {canvas2d:{pixel:canvasPixel,passed:canvasPixel.every((value,index)=>value===[51,153,204,255][index])},webgl:[webgl('webgl'),webgl('webgl2')]};
})()`;
