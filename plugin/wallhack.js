(function(){
    const oldDraw = drawScene;
    drawScene = function() {
        oldDraw();
        const ctx = document.getElementById('screen').getContext('2d');
        ctx.save();
        ctx.strokeStyle = '#0f0';
        ctx.fillStyle = '#0f0';
        ctx.lineWidth = 1;
        ctx.font = "8px 'Press Start 2P'";
        
        const entities = [...Object.values(players), ...bots];
        
        entities.forEach(e => {
            if (e.id === myId || e.hp <= 0) return;
            
            const X = (e.x - px) / 64;
            const Y = (e.y - py) / 64;
            const inv = 1.0 / (planeX * dirY - dirX * planeY);
            const tX = inv * (dirY * X - dirX * Y);
            const tY = inv * (-planeY * X + planeX * Y);
            
            if (tY > 0) {
                const sX = 160 * (1 + tX / tY);
                const h = Math.abs(200 / tY);
                const w = h / 2;
                const T = (200 - h) / 2;
                const L = sX - w / 2;
                
                ctx.strokeRect(L, T, w, h);
                ctx.fillText(`${e.username||'ENEMY'} ${tY|0}m`, L, T - 5);
                
                ctx.beginPath();
                ctx.moveTo(160, 200);
                ctx.lineTo(L + w / 2, T + h);
                ctx.stroke();
            }
        });
        
        ctx.restore();
    }
})();
