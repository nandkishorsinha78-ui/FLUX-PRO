import os
import shutil
from PIL import Image

print("=== GENERATING MULTI-PLATFORM LOGO & ICON ASSETS FROM MASTER SOURCE ===")

# 1. Paths setup
source_logo_path = r"C:\Users\nandk\.gemini\antigravity-ide\brain\14f06cdd-621b-44be-99b9-ace208bb4aa8\.user_uploaded\media_1788008584861.jpg"
base_dir = r"d:\GOOGLE ANTIGRAVITY IDE\image-image-bam"

master_dir = os.path.join(base_dir, "assets", "logo", "master")
windows_dir = os.path.join(base_dir, "assets", "logo", "windows")
android_dir = os.path.join(base_dir, "assets", "logo", "android", "launcher")
web_dir = os.path.join(base_dir, "assets", "logo", "web")
public_dir = os.path.join(base_dir, "public")
res_dir = os.path.join(base_dir, "android", "app", "src", "main", "res")

for d in [master_dir, windows_dir, android_dir, web_dir, public_dir, res_dir]:
    os.makedirs(d, exist_ok=True)

# Copy Master Source Logo
master_copy_path = os.path.join(master_dir, "nandu_flux_transparent_v2.png")
shutil.copyfile(source_logo_path, master_copy_path)
print(f"[OK] Master logo copied to: {master_copy_path}")
# Open Source Image
img = Image.open(master_copy_path).convert("RGBA")
width, height = img.size
print(f"[OK] Master Logo Resolution: {width}x{height}")

# 2. Windows Icon Assets (.ico and multi-res PNGs)
win_sizes = [16, 24, 32, 48, 64, 128, 256]
win_images = []

for size in win_sizes:
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    png_path = os.path.join(windows_dir, f"icon-{size}.png")
    resized.save(png_path, "PNG")
    win_images.append(resized)

# Save multi-resolution Windows .ico file
ico_path = os.path.join(windows_dir, "app.ico")
img.save(ico_path, format="ICO", sizes=[(s, s) for s in win_sizes])
print(f"[OK] Windows app.ico created: {ico_path} with sizes {win_sizes}")

# 3. Android Launcher Mipmap Assets
android_densities = {
    "mipmap-mdpi": 48,
    "mipmap-hdpi": 72,
    "mipmap-xhdpi": 96,
    "mipmap-xxhdpi": 144,
    "mipmap-xxxhdpi": 192
}

for density_folder, size in android_densities.items():
    # Assets folder backup
    density_dir_assets = os.path.join(android_dir, density_folder)
    os.makedirs(density_dir_assets, exist_ok=True)
    
    # App src res folder
    density_dir_res = os.path.join(res_dir, density_folder)
    os.makedirs(density_dir_res, exist_ok=True)
    
    resized = img.resize((size, size), Image.Resampling.LANCZOS)
    
    # Save standard, round, and foreground launcher icons
    for name in ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]:
        resized.save(os.path.join(density_dir_assets, name), "PNG")
        resized.save(os.path.join(density_dir_res, name), "PNG")

print("[OK] Android launcher mipmap icons generated for mdpi, hdpi, xhdpi, xxhdpi, xxxhdpi")

# 4. Web Assets (Public folder & Web asset folder)
img_512 = img.resize((512, 512), Image.Resampling.LANCZOS)
img_512.save(os.path.join(public_dir, "logo.png"), "PNG")
img_512.save(os.path.join(web_dir, "logo.png"), "PNG")

favicon_32 = img.resize((32, 32), Image.Resampling.LANCZOS)
favicon_32.save(os.path.join(public_dir, "favicon.png"), "PNG")
favicon_32.save(os.path.join(web_dir, "favicon.png"), "PNG")
favicon_32.save(os.path.join(public_dir, "favicon.ico"), format="ICO", sizes=[(32, 32)])

print("[OK] Web logo and favicons generated cleanly in public/ and assets/logo/web/")
print("=== LOGO ASSET GENERATION COMPLETE ===")
