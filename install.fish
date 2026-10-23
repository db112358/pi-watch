#!/usr/bin/env fish
# Install watch: symlink its extension dir into ~/.pi/agent/extensions. Idempotent.
# Safe to re-run after moving the repo.

set -l repo (cd (dirname (status filename)); and pwd)
set -l ext_dir ~/.pi/agent/extensions

# Type resolution for the editor and tests: point node_modules at the active release.
if not test -e $repo/node_modules
    set -l active (readlink $ext_dir/node_modules)
    if test -n "$active"
        ln -sfn "$active" $repo/node_modules
        echo "watch: node_modules -> $active"
    else
        echo "watch: no active pi node_modules; run 'dbe pi install-types' after installing pi" >&2
    end
end

mkdir -p $ext_dir
if test -e $ext_dir/watch; and not test -L $ext_dir/watch
    mv $ext_dir/watch $ext_dir/watch.bak
    echo "watch: backed up $ext_dir/watch -> $ext_dir/watch.bak"
end
ln -sfn $repo/watch $ext_dir/watch
echo "watch: $ext_dir/watch -> $repo/watch"
