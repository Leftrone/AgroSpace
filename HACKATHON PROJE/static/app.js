const API_BASE = '/api';
const canvas = document.getElementById('ndvi-canvas');
const ctx = canvas.getContext('2d');
const svg = document.getElementById('overlay-svg');
const zoomWrapper = document.getElementById('zoom-wrapper');
const loader = document.getElementById('loader');
const resetBtn = document.getElementById('reset-zoom');

// Zoom & Pan State
let scale = 1;
let translateX = 0;
let translateY = 0;
let isPanning = false;
let startX, startY;

// Data State
let mosaicGrid = null;
let patchTimeout = null;
let currentPatchData = null;

// NDVI Color Palette
function getNDVIColor(val) {
    // If NoData (Sea), return a vibrant sea blue
    if (isNaN(val) || val === null) return [29, 78, 216, 255]; 
    if (val > 0.8) return [0, 68, 27, 255];
    if (val > 0.6) return [35, 139, 69, 255];
    if (val > 0.4) return [102, 194, 164, 255];
    if (val > 0.2) return [204, 235, 197, 255];
    if (val > 0.1) return [255, 255, 204, 255];
    if (val > 0)   return [191, 129, 45, 255];
    return [140, 81, 10, 255];
}

async function init() {
    loader.classList.remove('hidden');
    try {
        const [mosaicRes, borderRes, citiesRes, districtsRes] = await Promise.all([
            fetch(`${API_BASE}/mosaic?downsample=8`),
            fetch('turkey_border.json'),
            fetch('cities.json'),
            fetch('districts.json')
        ]);

        const mosaicData = await mosaicRes.json();
        const borderData = await borderRes.json();
        const citiesData = await citiesRes.json();
        const districtsData = await districtsRes.json();

        renderMap(mosaicData, borderData, citiesData, districtsData);
        updateStats(mosaicData.stats);
        setupInteractions();
    } catch (err) {
        console.error('Error initializing map:', err);
    } finally {
        setTimeout(() => loader.classList.add('hidden'), 500);
    }
}

function renderMap(mosaic, border, cities, districts) {
    const data = mosaic.mosaic;
    mosaicGrid = data;
    const rows = data.length;
    const cols = data[0].length;

    canvas.width = cols;
    canvas.height = rows;
    
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = cols; tempCanvas.height = rows;
    const tCtx = tempCanvas.getContext('2d');
    const imageData = tCtx.createImageData(cols, rows);
    const d = imageData.data;

    for (let i = 0; i < rows; i++) {
        for (let j = 0; j < cols; j++) {
            const val = data[i][j];
            const color = getNDVIColor(val);
            const idx = (i * cols + j) * 4;
            d[idx] = color[0]; d[idx+1] = color[1]; d[idx+2] = color[2]; d[idx+3] = color[3];
        }
    }
    tCtx.putImageData(imageData, 0, 0);

    const project = (lng, lat) => {
        const x = ((lng - 10) / 50) * cols;
        const y = ((50 - lat) / 20) * rows;
        return [x, y];
    };

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw Background Sea (full canvas)
    ctx.fillStyle = '#1d4ed8'; // Default aquatic blue
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(tempCanvas, 0, 0);

    svg.setAttribute('viewBox', `0 0 ${cols} ${rows}`);
    svg.innerHTML = '';
    
    // Sınır çizgisi çizimi kaldırıldı

    const citiesGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    citiesGroup.id = 'cities-group';
    svg.appendChild(citiesGroup);
    
    const districtsGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    districtsGroup.id = 'districts-group';
    districtsGroup.style.display = 'none'; // hidden at lower zoom
    svg.appendChild(districtsGroup);

    const helperDraw = (places, parent) => {
        places.forEach(place => {
            const [cx, cy] = project(place.lng, place.lat);
            if (cx < 0 || cx > cols || cy < 0 || cy > rows) return;
            const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', cx); circle.setAttribute('cy', cy); circle.setAttribute('r', '3');
            circle.setAttribute('fill', 'var(--accent)');
            circle.classList.add('map-circle');
            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('x', cx + 4); text.setAttribute('y', cy + 2);
            text.setAttribute('fill', 'white');
            text.setAttribute('font-size', '8');
            text.setAttribute('font-weight', '600');
            text.setAttribute('style', 'text-shadow: 0 0 3px black;');
            text.classList.add('map-text');
            text.textContent = place.name;
            group.appendChild(circle); group.appendChild(text);
            parent.appendChild(group);
        });
    };
    
    helperDraw(cities, citiesGroup);
    helperDraw(districts, districtsGroup);

    // Initial positioning
    const container = document.getElementById('map-container');
    const containerRect = container.getBoundingClientRect();
    const cW = containerRect.width || window.innerWidth;
    const cH = containerRect.height || window.innerHeight;
    
    const mapAspect = cols / rows;
    const containerAspect = cW / cH;
    
    // Default sensible scale
    if (containerAspect > mapAspect) {
        scale = (cH * 0.8) / rows;
    } else {
        scale = (cW * 0.8) / cols;
    }
    
    translateX = (cW - (cols * scale)) / 2;
    translateY = (cH - (rows * scale)) / 2;
    
    updateTransform();
}

function setupInteractions() {
    const container = document.getElementById('map-container');
    const hoverPanel = document.getElementById('hover-panel');
    const hoverCoords = document.getElementById('hover-coords');
    const hoverNdvi = document.getElementById('hover-ndvi');
    
    container.addEventListener('wheel', (e) => {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.9 : 1.1;
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const nextScale = Math.min(Math.max(scale * delta, 0.1), 100);
        
        // Accurate zoom-to-cursor math
        translateX -= (mouseX - translateX) * (nextScale / scale - 1);
        translateY -= (mouseY - translateY) * (nextScale / scale - 1);
        scale = nextScale;
        
        updateTransform();
    }, { passive: false });

    container.addEventListener('mousedown', (e) => {
        isPanning = true;
        startX = e.clientX - translateX;
        startY = e.clientY - translateY;
        container.style.cursor = 'grabbing';
    });

    window.addEventListener('mousemove', (e) => {
        if (!isPanning) return;
        translateX = e.clientX - startX;
        translateY = e.clientY - startY;
        updateTransform();
    });

    window.addEventListener('mouseup', () => { 
        isPanning = false; 
        container.style.cursor = 'grab';
    });

    container.addEventListener('mousemove', (e) => {
        if (!mosaicGrid || isPanning) {
            hoverPanel.classList.add('hidden');
            return;
        }
        
        const rect = container.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;
        
        const canvasX = (mouseX - translateX) / scale;
        const canvasY = (mouseY - translateY) / scale;
        
        const col = Math.floor(canvasX);
        const row = Math.floor(canvasY);
        
        const rows = canvas.height;
        const cols = canvas.width;
        
        if (row >= 0 && row < rows && col >= 0 && col < cols) {
            let val = mosaicGrid[row][col];
            
            if (currentPatchData && currentPatchData.data) {
                const [rx, ry, rw, rh] = currentPatchData.rect;
                if (canvasX >= rx && canvasX < rx + rw && canvasY >= ry && canvasY < ry + rh) {
                    const pr = currentPatchData.data.length;
                    const pc = currentPatchData.data[0].length;
                    
                    const pC = Math.floor(((canvasX - rx) / rw) * pc);
                    const pR = Math.floor(((canvasY - ry) / rh) * pr);
                    
                    if (pR >= 0 && pR < pr && pC >= 0 && pC < pc) {
                        val = currentPatchData.data[pR][pC];
                    }
                }
            }
            
            const lng = (canvasX / cols) * 50 + 10;
            const lat = 50 - (canvasY / rows) * 20;

            hoverPanel.classList.remove('hidden');
            hoverCoords.textContent = `${Math.abs(lat).toFixed(2)}°${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(2)}°${lng >= 0 ? 'E' : 'W'}`;
            
            if (val === null || isNaN(val)) {
                hoverNdvi.textContent = 'Veri Yok';
                hoverNdvi.style.color = 'var(--text-dim)';
            } else {
                hoverNdvi.textContent = val.toFixed(3);
                hoverNdvi.style.color = 'var(--accent)';
            }
        } else {
            hoverPanel.classList.add('hidden');
        }
    });

    container.addEventListener('mouseleave', () => {
        if (!isPanning) {
            hoverPanel.classList.add('hidden');
        }
    });

    resetBtn.onclick = () => {
        const containerRect = container.getBoundingClientRect();
        const cW = containerRect.width || window.innerWidth;
        const cH = containerRect.height || window.innerHeight;
        const rows = canvas.height;
        const cols = canvas.width;
        
        if ((cW / cH) > (cols / rows)) {
            scale = (cH * 0.8) / rows;
        } else {
            scale = (cW * 0.8) / cols;
        }
        translateX = (cW - (cols * scale)) / 2;
        translateY = (cH - (rows * scale)) / 2;
        updateTransform();
    };
}

function updateTransform() {
    zoomWrapper.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    
    // Scale texts inversely
    const circleRadius = Math.max(0.1, 3 / scale);
    const fontSize = Math.max(0.2, 8 / scale);
    const shadowSize = Math.max(0.1, 3 / scale);
    
    document.querySelectorAll('.map-circle').forEach(c => c.setAttribute('r', circleRadius));
    document.querySelectorAll('.map-text').forEach(t => {
        t.setAttribute('font-size', fontSize);
        t.style.textShadow = `0 0 ${shadowSize}px black`;
    });
    
    // Toggle cities vs districts
    const cg = document.getElementById('cities-group');
    const dg = document.getElementById('districts-group');
    if (cg && dg) {
        if (scale > 15) {
            cg.style.display = 'none';
            dg.style.display = 'block';
        } else {
            cg.style.display = 'block';
            dg.style.display = 'none';
        }
    }

    fetchHighresPatch();
}

function fetchHighresPatch() {
    clearTimeout(patchTimeout);
    
    if (scale <= 1.5) {
        document.getElementById('highres-container').innerHTML = '';
        currentPatchData = null;
        return;
    }
    
    patchTimeout = setTimeout(() => {
        const container = document.getElementById('map-container');
        const hc = document.getElementById('highres-container');
        const loaderPatch = document.getElementById('patch-loader');
        
        const cw = container.clientWidth || window.innerWidth;
        const ch = container.clientHeight || window.innerHeight;
        
        let x1 = (0 - translateX) / scale;
        let y1 = (0 - translateY) / scale;
        let x2 = (cw - translateX) / scale;
        let y2 = (ch - translateY) / scale;
        
        const cols = canvas.width;
        const rows = canvas.height;
        
        x1 = Math.max(0, Math.min(cols, x1));
        y1 = Math.max(0, Math.min(rows, y1));
        x2 = Math.max(0, Math.min(cols, x2));
        y2 = Math.max(0, Math.min(rows, y2));
        
        if (x1 >= x2 || y1 >= y2) return;
        
        const min_lon = (x1 / cols) * 50 + 10;
        const max_lon = (x2 / cols) * 50 + 10;
        const max_lat = 50 - (y1 / rows) * 20;
        const min_lat = 50 - (y2 / rows) * 20;
        
        const target_w = Math.min(1200, Math.floor((x2 - x1) * scale));
        
        if (loaderPatch) loaderPatch.classList.remove('hidden');
        
        fetch(`${API_BASE}/patch?min_lat=${min_lat}&max_lat=${max_lat}&min_lon=${min_lon}&max_lon=${max_lon}&target_w=${target_w}`)
            .then(r => r.json())
            .then(res => {
                if (loaderPatch) loaderPatch.classList.add('hidden');
                if (!res.patch || res.patch.length === 0) return;
                
                const patchCanvas = document.createElement('canvas');
                patchCanvas.className = 'highres-patch';
                
                const patchRows = res.patch.length;
                const patchCols = res.patch[0].length;
                patchCanvas.width = patchCols;
                patchCanvas.height = patchRows;
                
                const pCtx = patchCanvas.getContext('2d');
                const imgData = pCtx.createImageData(patchCols, patchRows);
                const d = imgData.data;
                
                for(let r=0; r<patchRows; r++) {
                    for(let c=0; c<patchCols; c++) {
                        const val = res.patch[r][c];
                        const color = getNDVIColor(val);
                        const idx = (r * patchCols + c) * 4;
                        d[idx] = color[0]; d[idx+1] = color[1]; d[idx+2] = color[2]; d[idx+3] = color[3];
                    }
                }
                pCtx.putImageData(imgData, 0, 0);
                
                const [rx, ry, rw, rh] = res.rect;
                patchCanvas.style.left = rx + 'px';
                patchCanvas.style.top = ry + 'px';
                patchCanvas.style.width = rw + 'px';
                patchCanvas.style.height = rh + 'px';
                
                hc.innerHTML = '';
                hc.appendChild(patchCanvas);
                
                currentPatchData = {
                    data: res.patch,
                    rect: res.rect
                };
            }).catch(err => {
                console.error('Error fetching patch:', err);
                if (loaderPatch) loaderPatch.classList.add('hidden');
            });
    }, 450);
}

function updateStats(stats) {
    document.getElementById('stat-min').textContent = stats.min.toFixed(2);
    document.getElementById('stat-max').textContent = stats.max.toFixed(2);
    document.getElementById('stat-mean').textContent = stats.mean.toFixed(2);
    document.getElementById('stat-cov').textContent = (stats.coverage * 100).toFixed(1) + '%';
}

init();
