import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { ownerT } from "../platform/language.ts";
import { COMMAND_NAME } from "../../../contracts/src/names.ts";
import { isOwnerOnly } from "../platform/windows/acl.ts";

/**
 * Read a secret file (P1-03: the command line's credential, keys/) only if
 * it is a regular file owned by this process's user and not
 * readable/writable by group or others (S-3). Another account that could
 * read it would act as the owner on the local face, so a loose file
 * refuses start-up instead of silently running.
 *
 * Non-regular files (FIFO, device, socket, directory) are refused before
 * open (a FIFO would block start-up forever, a device open can have side
 * effects); the open itself is O_NONBLOCK | O_NOFOLLOW so a swap between the
 * check and the open can neither hang nor follow a link, and the opened
 * descriptor is checked again. An empty file (after trimming) is refused:
 * it would otherwise silently disable host mode.
 */
export function readSecretFile(
  path: string,
  expectedUid: number | undefined = process.getuid?.(),
): string {
  try {
    const pre = lstatSync(path);
    if (pre.isSymbolicLink())
      throw new Error(ownerT()("server-access.secret.symlink", { file: path }));
    if (!pre.isFile()) throw new Error(ownerT()("server-access.secret.notFile", { file: path }));
  } catch (e: any) {
    if (!e?.code) throw e;
    throw new Error(ownerT()("server-access.secret.unreadable", { file: path, error: String(e?.message || e) }));
  }
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (e: any) {
    throw new Error(
      e?.code === "ELOOP"
        ? ownerT()("server-access.secret.symlink", { file: path })
        : ownerT()("server-access.secret.unreadable", { file: path, error: String(e?.message || e) }),
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error(ownerT()("server-access.secret.notFile", { file: path }));
    if (expectedUid !== undefined && st.uid !== expectedUid)
      throw new Error(
        ownerT()("server-access.secret.otherOwner", { file: path, uid: st.uid, own: expectedUid }),
      );
    // Windows (P5-05, ADR-141): mode bits mean nothing there — the DACL
    // must let only this account, SYSTEM and Administrators in (null:
    // the helper is not there to tell; accepted, said in the log).
    if (process.platform === "win32") {
      if (isOwnerOnly(path) === false)
        throw new Error(
          ownerT()("server-access.secret.aclLoose", { file: path }),
        );
    } else if ((st.mode & 0o077) !== 0) {
      const mode = st.mode & 0o777;
      throw new Error(
        ownerT()("server-access.secret.modeLoose", { file: path, mode: mode.toString(8).padStart(4, "0") }),
      );
    }
    const secret = readFileSync(fd, "utf8").trim();
    if (!secret)
      throw new Error(
        ownerT()("server-access.secret.empty", { file: path }),
      );
    return secret;
  } finally {
    closeSync(fd);
  }
}
