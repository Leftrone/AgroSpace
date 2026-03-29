import os
import shutil
import glob
import gdown

# Sizin verdiğiniz Google Drive klasör bağlantısı
FOLDER_URL = 'https://drive.google.com/drive/folders/1QEMBTaR2tOLke5VSa7i2An1YMqrFOko7?usp=sharing'

def download_files_if_missing():
    required_files = ["edirne.hdf", "kafkasya.hdf", "karadeniz.hdf", "konya.hdf", "suri.hdf", "guneyyunan.hdf"]
    
    # Hangi dosyaların eksik olduğunu kontrol ediyoruz
    missing_files = [f for f in required_files if not os.path.exists(f)]
    
    if missing_files:
        print(f"Eksik HDF dosyaları var ({len(missing_files)} adet). Mükemmel, Google Drive'dan topluca indiriliyor...")
        output_dir = "gdrive_downloaded"
        
        # Klasörü indir komutu
        gdown.download_folder(url=FOLDER_URL, output=output_dir, quiet=False, use_cookies=False)
        
        # İndirilen dosyaları ana dizine (main.py'nin yanına) çıkaralım
        for filepath in glob.glob(f"{output_dir}/*.hdf"):
            filename = os.path.basename(filepath)
            # Eğer zaten varsa üzerine yazmasını istemeyiz ama biz zaten eksik diye kontrol etmiştik.
            shutil.move(filepath, filename)
            print(f"HDF Dosyası yerleştirildi: {filename}")
            
        # Boş (veya gereksiz dosya örneğin desktop.ini barındıran) klasörü temizleyelim
        try:
            shutil.rmtree(output_dir)
        except Exception:
            pass
            
        print("Tüm HDF verileri başarıyla indirildi ve yerleştirildi!")
    else:
        print("Bütün HDF dosyaları ana dizinde mevcut. İndirmeye gerek yok.")
        
if __name__ == "__main__":
    download_files_if_missing()
