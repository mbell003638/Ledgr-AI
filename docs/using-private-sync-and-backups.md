# Ledgr: the simple guide to backups and Private sync

## The one-sentence version

**You can use Ledgr without a server.** Your work is saved on your device first. You only need Private sync when two or more devices must share the same business book.

> Think of your business book like a notebook. Local-only mode keeps the notebook on your device. An encrypted backup is a locked copy. Private sync lets your approved devices share carefully checked changes through a server that you or your business controls.

## Which button should I use?

| If you want to… | Use this |
|---|---|
| Keep using Ledgr on one device | **Local-only mode** |
| Make a safe copy of your book | **Encrypted backup** |
| Let another device see the same business | **Private sync** |
| See whether the server or queue needs attention | **Sync Health** |
| Add or remove a phone, tablet, or computer | **Sync Administration** |

You do not need to turn on Private sync just to make a backup. A backup is a locked copy. Private sync is for sharing work between approved devices.

## Everyday use: Local-only mode

1. Open Ledgr and choose your business type during setup.
2. Enter sales, purchases, payments, expenses, stock changes, invoices, and other enabled work normally.
3. Ledgr saves the work on this device even when the internet is off.
4. Make an encrypted backup before changing phones, resetting the device, or making a big setup change.

Local-only mode is the right choice for a solo business or one device. No Ledgr cloud account is required.

## Make an encrypted backup

1. Open **Settings**.
2. Tap **Encrypted backup** in the Local-only card, or open **Backup & Recovery**.
3. Tap **Export encrypted backup**.
4. Choose a strong passphrase that you can remember. Do not send the passphrase with the backup file.
5. Save the file somewhere you control, such as your computer or your own storage.
6. Keep the original backup file. Do not edit it.

The passphrase is not saved in ordinary app settings. If you forget it, Ledgr cannot unlock that backup.

## Check or restore a backup

1. Open **Backup & Recovery**.
2. Choose **Import encrypted backup** and select the backup file.
3. Enter the passphrase.
4. Ledgr checks the lock, file integrity, schema version, and Business Account identity.
5. Read the dry-run result. This is a safety preview; it does not replace your book.
6. Continue only when the Business Account and backup date are correct.
7. Ledgr creates a recovery record and then performs the explicit restore.

If the passphrase is wrong, the file is damaged, or the backup belongs to another book, stop and use the recovery message. Do not keep guessing on a valuable file.

## When should I use Private sync?

Use Private sync when an owner, accountant, shop tablet, POS device, warehouse device, or another approved person needs the same current business book.

Private sync uses a server owned or chosen by your business. It is optional. Ledgr does not require a Ledgr-hosted server.

## Move from one device to Private sync

1. Open **Settings**.
2. Tap **Private sync**.
3. On the simple setup screen, choose **Set up my own server**.
4. Tap **Open guided setup**.
5. Ledgr checks that the local book can be read and that a recent verified encrypted backup exists.
6. Enter your user-owned server address and temporary sign-in details.
7. Ledgr tells you whether the server is empty or already has a business book.
8. If it is empty, review the destination and choose **Publish the first snapshot**.
9. If it already has data, review the Business Account identity and choose **Install the validated server snapshot** only when it is the correct business.
10. Check **Sync Health** after the first exchange.

Ledgr does not upload a raw SQLite file. Pending local work stays protected and is handled through validated operations.

## Join a business on another device

1. Ask the administrator for the server address, your user ID, a one-time code, and a temporary access token.
2. Open **Settings → Private sync** on the new device.
3. Choose **Join an existing business**.
4. Enter the server address, user ID, one-time code, device name, and temporary token.
5. Tap **Join this business**.
6. The administrator’s role and location access are applied by the server.
7. Open **Sync Health** and wait for the first verified update.

The one-time code expires and cannot be reused. Give each device a clear name, such as “Front counter tablet” or “Owner phone”.

## If something is waiting or red

1. Tap the small sync-attention indicator, or open **Sync Health**.
2. Read the plain-language message.
3. If work is waiting, keep using Ledgr. Your local work is safe and will retry when the server is available.
4. Tap **Retry** when the server is back.
5. If there is a conflict, read what this device tried to do and what the server already accepted.
6. Keep the accepted server result, retry against the latest data, or create an audited correction. Do not guess.
7. Ask the business administrator or accountant when the message says approval is needed.

A conflict is not a lost sale. It is Ledgr asking a person to choose the safe accounting result.

## If a device is lost

1. Ask the owner or administrator to open **Sync Administration**.
2. Find the device by its name.
3. Tap **Revoke**.
4. The lost device can no longer push or pull new Private sync operations.
5. Other devices and the business book remain unchanged.
6. A replacement device can join with a new one-time code.

## The three rules to remember

1. **Local work comes first.** Keep recording business activity even when the internet is down.
2. **Backups and sync are different.** A backup is a locked copy; sync shares approved changes.
3. **Read before you confirm.** Ledgr stops before a risky restore, conflict, or first remote snapshot so you can choose safely.

## For the person running the server

The server is the business owner’s responsibility. Use the deployment package’s `preflight.sh`, `install.sh`, `install-advanced.sh`, `backup.sh`, `restore-drill.sh`, and `upgrade.sh`. Keep PostgreSQL private, use HTTPS, configure an explicit CORS origin, store secrets with restricted permissions, run encrypted backups, and complete a restore drill before upgrades.

For technical deployment requirements and rollback evidence, see `sync-server/deploy/RELEASE_CHECKLIST.md` and `sync-server/deploy/RUNBOOK.md`.
