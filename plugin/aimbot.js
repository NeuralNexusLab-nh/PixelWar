(function(){
    console.log("%c [AIMBOT] INJECTED ", "color: red; background: black; font-weight: bold;");
    const sensitivity = 1.0; 
    
    setInterval(() => {
        if(!window.mouseState || !window.mouseState.right) return;
        let target = null;
        let minDist = Infinity;
        [...Object.values(players), ...bots].forEach(e => {
            if(e.id === myId || e.hp <= 0) return;
            const dist = (e.x - px)**2 + (e.y - py)**2;
            if(dist < minDist) { minDist = dist; target = e; }
        });
        if(target) {
            const dx = target.x - px;
            const dy = target.y - py;
            const targetAngle = Math.atan2(dy, dx);
            const currentAngle = Math.atan2(dirY, dirX);
            let diff = targetAngle - currentAngle;
            while(diff < -Math.PI) diff += Math.PI*2;
            while(diff > Math.PI) diff -= Math.PI*2;
            const rot = -diff * 0.2;
            const oldDirX = dirX;
            dirX = dirX * Math.cos(rot) - dirY * Math.sin(rot);
            dirY = oldDirX * Math.sin(rot) + dirY * Math.cos(rot);
            const oldPlaneX = planeX;
            planeX = planeX * Math.cos(rot) - planeY * Math.sin(rot);
            planeY = oldPlaneX * Math.sin(rot) + planeY * Math.cos(rot);
        }
    }, 16);
})();
