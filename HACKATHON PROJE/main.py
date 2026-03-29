from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pyhdf.SD import SD, SDC
import numpy as np
import os
from typing import List, Dict

app = FastAPI(title="NDVI Visualization API")

# Enable CORS for frontend interaction
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount static files (will be moved to the end)

DATA_FILES = {
    "edirne": "edirne.hdf",
    "kafkasya": "kafkasya.hdf",
    "karadeniz": "karadeniz.hdf",
    "konya": "konya.hdf",
    "suri": "suri.hdf"
}

def get_tile_data(file_path: str, downsample: int = 4):
    """ Reads NDVI data from a single HDF file. """
    if not os.path.exists(file_path):
        return None
    try:
        hdf = SD(file_path, SDC.READ)
        var_name = '500m 16 days NDVI'
        try:
            dataset = hdf.select(var_name)
        except Exception:
            hdf.end()
            return None
        # Load raw data and convert to float32 immediately
        raw_data = dataset[:]
        data = np.asarray(raw_data, dtype=np.float32)
        
        # MODIS NDVI Fill Value is -3000, and valid range is -2000 to 10000.
        # We handle all non-land pixels by masking everything <= -2000.
        data[data <= -2000] = np.nan
        
        # Scale to NDVI standard range (-0.1 to 1.0)
        ndvi = data * 0.0001
        
        if downsample > 1:
            ndvi = ndvi[::downsample, ::downsample]
        dataset.endaccess()
        hdf.end()
        return ndvi
    except Exception as e:
        print(f"Error reading {file_path}: {e}")
        return None

def get_tile_patch(file_path: str, row_start: int, row_end: int, col_start: int, col_end: int, step: int):
    """ Reads a specific sliced region from the HDF dataset efficiently """
    h = row_end - row_start
    w = col_end - col_start
    out_h = (h + step - 1) // step
    out_w = (w + step - 1) // step
    
    if h <= 0 or w <= 0 or not os.path.exists(file_path):
        return np.full((max(0, out_h), max(0, out_w)), np.nan, dtype=np.float32)

    try:
        hdf = SD(file_path, SDC.READ)
        var_name = '500m 16 days NDVI'
        dataset = hdf.select(var_name)
        
        raw_data = dataset[row_start:row_end:step, col_start:col_end:step]
        data = np.asarray(raw_data, dtype=np.float32)
        
        data[data <= -2000] = np.nan
        ndvi = data * 0.0001
        
        dataset.endaccess()
        hdf.end()
        return ndvi
    except Exception as e:
        print(f"Error reading patch from {file_path}: {e}")
        return np.full((max(0, out_h), max(0, out_w)), np.nan, dtype=np.float32)

@app.get("/api/mosaic")
async def get_mosaic(downsample: int = 8):
    """
    Stitches the 5 HDF tiles into a single 3x2 mosaic grid.
    Grid structure (h21-h23, v04-v05):
    [Edirne] [Karadeniz] [Kafkasya]
    [None]   [Konya]     [Suri]
    """
    tiles = {
        (0, 0): "edirne.hdf",    # h21v04
        (0, 1): "karadeniz.hdf", # h22v04
        (0, 2): "kafkasya.hdf",  # h23v04
        (1, 0): "guneyyunan.hdf",# h21v05 [NEW]
        (1, 1): "konya.hdf",     # h22v05
        (1, 2): "suri.hdf"       # h23v05
    }
    
    # Each tile is 2400x2400. After downsample (default 8) it's 300x300.
    tile_size = 2400 // downsample
    mosaic = np.full((tile_size * 2, tile_size * 3), np.nan)
    
    for (r, c), fname in tiles.items():
        data = get_tile_data(fname, downsample)
        if data is not None:
            mosaic[r*tile_size:(r+1)*tile_size, c*tile_size:(c+1)*tile_size] = data
            
    # Calculate coverage based on 6 potential tiles
    stats = {
        "min": float(np.nanmin(mosaic)) if not np.all(np.isnan(mosaic)) else 0.0,
        "max": float(np.nanmax(mosaic)) if not np.all(np.isnan(mosaic)) else 0.0,
        "mean": float(np.nanmean(mosaic)) if not np.all(np.isnan(mosaic)) else 0.0,
        "coverage": float(np.count_nonzero(~np.isnan(mosaic)) / (tile_size * tile_size * 6))
    }
    
    # Replace NaN with None for JSON compliance
    mosaic_list = np.where(np.isnan(mosaic), None, mosaic).tolist()
    
    return {
        "mosaic": mosaic_list,
        "stats": stats,
        "resolution": f"{mosaic.shape[0]}x{mosaic.shape[1]}"
    }

@app.get("/api/patch")
async def get_patch(min_lat: float, max_lat: float, min_lon: float, max_lon: float, target_w: int = 800):
    total_cols = 7200
    total_rows = 4800
    
    x1 = int(((min_lon - 10) / 50.0) * total_cols)
    x2 = int(((max_lon - 10) / 50.0) * total_cols)
    y1 = int(((50.0 - max_lat) / 20.0) * total_rows)
    y2 = int(((50.0 - min_lat) / 20.0) * total_rows)
    
    gx1 = max(0, min(total_cols, x1))
    gx2 = max(0, min(total_cols, x2))
    gy1 = max(0, min(total_rows, y1))
    gy2 = max(0, min(total_rows, y2))
    
    w = gx2 - gx1
    h = gy2 - gy1
    
    if w <= 0 or h <= 0:
        return {"patch": [], "rect": [0, 0, 0, 0], "downsample": 1}
        
    downsample = max(1, w // target_w)
    
    tiles = {
        (0, 0): "edirne.hdf",    (0, 1): "karadeniz.hdf", (0, 2): "kafkasya.hdf",
        (1, 0): "guneyyunan.hdf",(1, 1): "konya.hdf",     (1, 2): "suri.hdf"
    }
    
    tile_size = 2400
    out_w = (w + downsample - 1) // downsample
    out_h = (h + downsample - 1) // downsample
    out_patch = np.full((out_h, out_w), np.nan, dtype=np.float32)
    
    for (r, c), fname in tiles.items():
        t_y1 = r * tile_size
        t_y2 = (r + 1) * tile_size
        t_x1 = c * tile_size
        t_x2 = (c + 1) * tile_size
        
        i_x1 = max(gx1, t_x1)
        i_x2 = min(gx2, t_x2)
        i_y1 = max(gy1, t_y1)
        i_y2 = min(gy2, t_y2)
        
        if i_x1 < i_x2 and i_y1 < i_y2:
            st_x1 = i_x1 - t_x1
            st_x2 = i_x2 - t_x1
            st_y1 = i_y1 - t_y1
            st_y2 = i_y2 - t_y1
            
            off_x = i_x1 - gx1
            off_y = i_y1 - gy1
            
            st_x1_c = st_x1 + ((downsample - (off_x % downsample)) % downsample)
            st_y1_c = st_y1 + ((downsample - (off_y % downsample)) % downsample)
            
            if st_x1_c < st_x2 and st_y1_c < st_y2:
                arr = get_tile_patch(fname, st_y1_c, st_y2, st_x1_c, st_x2, downsample)
                out_x = (i_x1 + (st_x1_c - st_x1) - gx1) // downsample
                out_y = (i_y1 + (st_y1_c - st_y1) - gy1) // downsample
                
                arr_h, arr_w = arr.shape
                # Ensure we don't exceed out_patch bounds due to rounding
                safe_h = min(arr_h, out_h - out_y)
                safe_w = min(arr_w, out_w - out_x)
                if safe_h > 0 and safe_w > 0:
                    out_patch[out_y:out_y+safe_h, out_x:out_x+safe_w] = arr[:safe_h, :safe_w]
    
    # Replace NaN with None for JSON compliance
    patch_list = np.where(np.isnan(out_patch), None, out_patch).tolist()
    
    return {
        "patch": patch_list,
        # return coordinates matching the base canvas space (downsample=8) for easy frontend overlaying
        # Base cols = 7200 / 8 = 900
        # Rect: [gx1 / 8, gy1 / 8, out_w * downsample / 8, out_h * downsample / 8]
        "rect": [gx1 / 8.0, gy1 / 8.0, out_w * downsample / 8.0, out_h * downsample / 8.0],
        "downsample": downsample,
        "grid": [gx1, gy1, gx2, gy2]
    }

@app.get("/api/regions")
async def get_regions():
    return list(DATA_FILES.keys())

@app.get("/api/data/{region}")
async def get_data(region: str, downsample: int = 4):
    if region not in DATA_FILES:
        raise HTTPException(status_code=404, detail="Region not found")
    
    data, stats = get_ndvi_data(DATA_FILES[region], downsample)
    if data is None:
        raise HTTPException(status_code=500, detail="Error reading data file")
    
    return {
        "region": region,
        "data": data,
        "stats": stats,
        "resolution": f"{len(data)}x{len(data[0])}"
    }

# Mount static files at root
app.mount("/", StaticFiles(directory="static", html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8005)
