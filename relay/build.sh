#!/bin/sh
# Puts the relay's pages together in public/: the phone-only Friends page at /, and the whole phone app at /m/
# (the iPhone's Premade icon), which opens with the PC off. The app's look and code come from the PC's own files.
set -e
cd "$(dirname "$0")"
UI=../pc/ui
rm -rf public && mkdir -p public/m
cp web/* public/
cp $UI/*.css $UI/icon.svg public/
cp -r $UI/m/* public/m/
# The offline copy's name changes with every deploy, so phones pick up new pages.
sed -i "s/__BUILD__/$(date +%s)/" public/m/sw.js
