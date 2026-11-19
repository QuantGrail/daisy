# JSON-framed PTY bridge. Executable/argv are chosen by the Runner, never a shell string.
import os, sys, pty, select, signal, termios, fcntl, struct, json, base64
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(sys.argv[1], sys.argv[1:], os.environ)
def resize(cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', max(5,min(150,rows)), max(20,min(500,cols)),0,0))
resize(100,30)
def stop(*_):
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    try: os.waitpid(pid,0)
    except ChildProcessError: pass
    sys.exit(143)
signal.signal(signal.SIGTERM,stop)
signal.signal(signal.SIGINT,stop)
buffer=b''
try:
    while True:
        ready,_,_=select.select([fd,sys.stdin.fileno()],[],[],1)
        if fd in ready:
            try: data=os.read(fd,49152)
            except OSError: break
            if not data: break
            sys.stdout.write(json.dumps({'data':base64.b64encode(data).decode('ascii')})+'\n');sys.stdout.flush()
        if sys.stdin.fileno() in ready:
            data=os.read(sys.stdin.fileno(),65536)
            if not data: stop()
            buffer+=data
            while b'\n' in buffer:
                line,buffer=buffer.split(b'\n',1)
                command=json.loads(line)
                if 'text' in command: os.write(fd,command['text'].encode('utf-8'))
                if 'cols' in command and 'rows' in command: resize(command['cols'],command['rows'])
finally:
    os.close(fd)
_,status=os.waitpid(pid,0)
sys.exit(os.waitstatus_to_exitcode(status))
