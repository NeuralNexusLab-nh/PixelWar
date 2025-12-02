(function(){
    console.log("%c [NOCLIP] READY (Press SHIFT) ", "color: cyan; background: black;");
    window.addEventListener('keydown', (e) => {
        if(e.key === 'Shift') {
            const jumpDist = 64;
            px += dirX * jumpDist;
            py += dirY * jumpDist;
            
            console.log("Teleported!");
        }
    });
})();
