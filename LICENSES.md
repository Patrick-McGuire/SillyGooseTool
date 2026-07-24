# Bundled Third-Party Assets

`index.html` is a standalone build that includes the following browser libraries:

- Plotly.js v2.27.0, MIT license, https://github.com/plotly/plotly.js
- JSZip v3.10.1, MIT or GPLv3 license, https://github.com/Stuk/jszip
- pako, used by JSZip, MIT license, https://github.com/nodeca/pako
- Leaflet v1.9.4, BSD-2-Clause license, https://github.com/Leaflet/Leaflet
- qrcode-generator v1.4.4, MIT license, https://github.com/kazuhikoarase/qrcode-generator

The local logo image in `src/assets/logo.png` is bundled as a data URI by `build.py`.

The navball texture in `src/assets/navball.png` is from AerospaceNU's
`pyqt_groundstation` (src/Assets/navball.png), reused with permission as a
same-org ground-station tool; that repo has no LICENSE file of its own.
