#!/usr/bin/env bash
# Update PKGBUILD for a release, regenerate .SRCINFO and (with --push) publish to the AUR.
# usage: publish.sh <tag> <deb-sha256> <pkgrel> [--push]     (--push needs AUR_SSH_PRIVATE_KEY)
set -euo pipefail
tag=$1 sha=$2 rel=$3 push=${4:-}
dir=$(cd "$(dirname "$0")" && pwd)
ver=$(node -p "require('$dir/../../package.json').version")

sed -i -e "s/^pkgver=.*/pkgver=$ver/" -e "s/^_tag=.*/_tag=$tag/" -e "s/^pkgrel=.*/pkgrel=$rel/" \
       -e "s/^sha256sums=.*/sha256sums=('$sha')/" "$dir/PKGBUILD"

# .SRCINFO from the PKGBUILD itself (makepkg is not available on the Ubuntu runner)
srcinfo() (
  source "$dir/PKGBUILD"
  echo "pkgbase = $pkgname"
  printf '\tpkgdesc = %s\n\tpkgver = %s\n\tpkgrel = %s\n\turl = %s\n' "$pkgdesc" "$pkgver" "$pkgrel" "$url"
  for f in arch license depends optdepends provides conflicts options noextract source sha256sums; do
    declare -n a=$f
    for v in "${a[@]}"; do printf '\t%s = %s\n' "$f" "$v"; done
  done
  printf '\npkgname = %s\n' "$pkgname"
)
srcinfo > "$dir/.SRCINFO"
echo "PKGBUILD/.SRCINFO updated for $ver ($tag)"
[ "$push" = "--push" ] || exit 0

work=$(mktemp -d)
install -d -m 700 ~/.ssh
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > ~/.ssh/aur && chmod 600 ~/.ssh/aur
ssh-keyscan -t ed25519,rsa aur.archlinux.org >> ~/.ssh/known_hosts 2>/dev/null
export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/aur -o IdentitiesOnly=yes"
git clone ssh://aur@aur.archlinux.org/steam-workspace-bin.git "$work"
cp "$dir/PKGBUILD" "$dir/.SRCINFO" "$work/"
cd "$work"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then echo "AUR already up to date"; exit 0; fi
git -c user.name=fadzlan -c user.email=fadzlan@gmail.com commit -m "Update to $tag"
git push origin HEAD:master
