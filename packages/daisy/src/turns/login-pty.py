# Fixed-argument PTY bridge for official CLI login. No shell, no general terminal API.
import os, sys, pty, select, signal, termios, fcntl, struct
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 4096, 0, 0))
attrs = termios.tcgetattr(fd)
attrs[3] &= ~termios.ECHO
termios.tcsetattr(fd, termios.TCSANOW, attrs)
def stop(*_):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid, 0)
    except ChildProcessError: pass
    sys.exit(143)
signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
try:
    while True:
        ready, _, _ = select.select([fd, sys.stdin.fileno()], [], [], 1)
        if fd in ready:
            try: data=os.read(fd, 65536)
            except OSError: break
            if not data: break
            os.write(sys.stdout.fileno(), data)
        if sys.stdin.fileno() in ready:
            data=os.read(sys.stdin.fileno(), 4096)
            if not data: stop()
            os.write(fd,data)
finally:
    os.close(fd)
_, status=os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
