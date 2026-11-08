#!/bin/sh
# Runs against a local relay: npx wrangler d1 execute premade-friends --local --file schema.sql && npx wrangler dev --local
# then: sh test.sh   (uses a fresh pair of people each run; the first person ever is the owner)
set -e
R=${R:-http://localhost:8787}
j() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
OWNER=${OWNER:?set OWNER to the owner token}
A="Authorization: Bearer"
NEW=$(curl -sf -XPOST $R/join -d '{"name":"Friend","devices":[{"id":"web","name":"iPhone","kind":"iphone"}]}')
FT=$(echo "$NEW" | j .token); FID=$(echo "$NEW" | j .id)
[ "$(echo "$NEW" | j .approved)" = false ] || { echo "a new person must wait for approval"; exit 1; }
[ "$(curl -s -o /dev/null -w %{http_code} -H "$A $FT" $R/inbox)" = 403 ] || { echo "unapproved can read inbox"; exit 1; }
curl -sf -H "$A $OWNER" $R/people | grep -q "\"$FID\"" || { echo "owner doesn't see the waiting person"; exit 1; }
[ "$(curl -s -o /dev/null -w %{http_code} -XPOST -H "$A $FT" $R/approve/$FID)" = 403 ] || { echo "non-owner approved"; exit 1; }
curl -sf -XPOST -H "$A $OWNER" $R/approve/$FID >/dev/null
OID=$(curl -sf -H "$A $FT" $R/people | j ".people.find(p=>p.name==='Rayan').id")
# A 60 MB file in two parts.
head -c 62914560 /dev/urandom > /tmp/fr-in.bin
S=$(curl -sf -XPOST -H "$A $FT" $R/send -d "{\"to\":\"$OID\",\"dev\":\"pc\",\"name\":\"clip.bin\",\"size\":62914560}")
ID=$(echo "$S" | j .id)
[ "$(curl -s -o /dev/null -w %{http_code} -XPOST -H "$A $FT" $R/send -d "{\"to\":\"$OID\",\"name\":\"big\",\"size\":2000000000}")" = 400 ] || { echo "over 1 GB accepted"; exit 1; }
head -c 52428800 /tmp/fr-in.bin > /tmp/fr-p1; tail -c 10485760 /tmp/fr-in.bin > /tmp/fr-p2
E1=$(curl -sf -XPUT -H "$A $FT" --data-binary @/tmp/fr-p1 $R/send/$ID/1 | j .etag)
E2=$(curl -sf -XPUT -H "$A $FT" --data-binary @/tmp/fr-p2 $R/send/$ID/2 | j .etag)
curl -s -H "$A $OWNER" $R/inbox | grep -q "$ID" && { echo "unfinished send visible"; exit 1; }
curl -sf -XPOST -H "$A $FT" $R/send/$ID/done -d "{\"parts\":[{\"n\":1,\"etag\":\"$E1\"},{\"n\":2,\"etag\":\"$E2\"}]}" >/dev/null
curl -sf -H "$A $OWNER" $R/inbox | grep -q "clip.bin" || { echo "not in inbox"; exit 1; }
curl -sf -H "$A $OWNER" $R/file/$ID -o /tmp/fr-out.bin
cmp /tmp/fr-in.bin /tmp/fr-out.bin || { echo "file changed on the way"; exit 1; }
curl -sf -XDELETE -H "$A $OWNER" $R/file/$ID >/dev/null
curl -s -H "$A $OWNER" $R/inbox | grep -q "$ID" && { echo "not deleted"; exit 1; }
curl -sf -XPOST -H "$A $OWNER" $R/remove/$FID >/dev/null
[ "$(curl -s -o /dev/null -w %{http_code} -H "$A $FT" $R/people)" = 401 ] || { echo "removed person still in"; exit 1; }
echo "relay ok"
