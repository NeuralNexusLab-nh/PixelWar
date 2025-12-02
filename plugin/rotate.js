(function(){
    let spinning = true;
    console.log("%c [SPINBOT] HELICOPTER MODE [Press K]", "color: magenta; background: black;");
    window.addEventListener('keydown', e => { if(e.key === 'k') spinning = !spinning; });
    const originalLoop = loop; 
    setInterval(() => {
        if(!spinning) return;
        const rot = 0.5;
        const oldDirX = dirX;
        dirX = dirX * Math.cos(rot) - dirY * Math.sin(rot);
        dirY = oldDirX * Math.sin(rot) + dirY * Math.cos(rot);
        const oldPlaneX = planeX;
        planeX = planeX * Math.cos(rot) - planeY * Math.sin(rot);
        planeY = oldPlaneX * Math.sin(rot) + planeY * Math.cos(rot);
        
        // 強制發送 input 讓伺服器知道你在轉
        socket.emit('input', { keys, angle: Math.atan2(dirY, dirX) });
    }, 16);
})();
