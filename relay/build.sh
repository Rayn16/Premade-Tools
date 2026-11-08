#!/bin/sh
# Puts the phone-only Friends page together in public/: its own files plus the app's look and Friends code.
set -e
cd "$(dirname "$0")"
UI=../pc/ui
rm -rf public && mkdir -p public/m/fonts
cp web/* public/
cp $UI/pt.css $UI/dl.css $UI/cv.css $UI/friends.css $UI/icon.svg public/
cp $UI/m/m.css $UI/m/common.js $UI/m/pdf-core.js $UI/m/friends-core.js $UI/m/icon-180.png public/m/
cp $UI/m/fonts/*.woff2 public/m/fonts/
