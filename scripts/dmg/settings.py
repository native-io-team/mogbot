# dmgbuild settings for the installer DMG (scripts/dmg/make-dmg.sh).
# dmgbuild writes the window's .DS_Store itself, so the layout never depends
# on Finder saving it (Finder silently didn't for 1.0.2's first DMG).
# Geometry: keep in step with background.html (660x420, icons at 170/490, y 210).
import os

app = defines["app"]  # noqa: F821 (dmgbuild passes `defines`)
background = defines["background"]  # noqa: F821
icon = defines.get("icon")  # noqa: F821
app_name = os.path.basename(app)

format = "UDZO"
compression_level = 9
filesystem = "HFS+"
files = [app]
symlinks = {"Applications": "/Applications"}
if not (icon and os.path.exists(icon)):
    icon = None

show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False
window_rect = ((200, 120), (660, 420))
default_view = "icon-view"
show_icon_preview = False
arrange_by = None
icon_size = 128
text_size = 13
label_pos = "bottom"
icon_locations = {app_name: (170, 210), "Applications": (490, 210)}
