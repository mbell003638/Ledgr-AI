#!/usr/bin/env python3
"""Patch android/app/build.gradle to use a release signing config in CI."""
import re
import sys

p = "app/build.gradle"
src = open(p).read()

if "MYAPP_RELEASE_STORE_FILE" in src:
    print("Signing already present")
    sys.exit(0)

signing = '''
        release {
            if (project.hasProperty('MYAPP_RELEASE_STORE_FILE')) {
                storeFile file(MYAPP_RELEASE_STORE_FILE)
                storePassword MYAPP_RELEASE_STORE_PASSWORD
                keyAlias MYAPP_RELEASE_KEY_ALIAS
                keyPassword MYAPP_RELEASE_KEY_PASSWORD
            }
        }
'''

src = re.sub(r"(signingConfigs\s*\{)", r"\1" + signing, src, count=1)
src = src.replace("signingConfig signingConfigs.debug",
                  "signingConfig signingConfigs.release")
open(p, "w").write(src)
print("Patched build.gradle release signing")
