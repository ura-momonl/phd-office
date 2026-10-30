"""Put UTF-8 text from stdin on the Windows clipboard as CF_UNICODETEXT (clip.exe guesses the encoding and garbles short CJK text)."""
import ctypes
import sys
import time
from ctypes import wintypes

CF_UNICODETEXT = 13
GMEM_MOVEABLE = 0x2


def main():
    text = sys.stdin.buffer.read().decode('utf-8')
    data = (text + '\0').encode('utf-16-le')
    k, u = ctypes.WinDLL('kernel32', use_last_error=True), ctypes.WinDLL('user32', use_last_error=True)
    k.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
    k.GlobalAlloc.restype = wintypes.HGLOBAL
    k.GlobalLock.argtypes = [wintypes.HGLOBAL]
    k.GlobalLock.restype = wintypes.LPVOID
    k.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
    k.GlobalFree.argtypes = [wintypes.HGLOBAL]
    u.OpenClipboard.argtypes = [wintypes.HWND]
    u.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
    u.SetClipboardData.restype = wintypes.HANDLE
    for _ in range(20):  # another process may hold the clipboard briefly
        if u.OpenClipboard(None):
            break
        time.sleep(0.05)
    else:
        print('OpenClipboard failed', file=sys.stderr)
        return 1
    try:
        u.EmptyClipboard()
        h = k.GlobalAlloc(GMEM_MOVEABLE, len(data))
        if not h:
            print('GlobalAlloc failed', file=sys.stderr)
            return 1
        p = k.GlobalLock(h)
        ctypes.memmove(p, data, len(data))
        k.GlobalUnlock(h)
        if not u.SetClipboardData(CF_UNICODETEXT, h):
            k.GlobalFree(h)
            print('SetClipboardData failed', file=sys.stderr)
            return 1
    finally:
        u.CloseClipboard()
    return 0


if __name__ == '__main__':
    sys.exit(main())
