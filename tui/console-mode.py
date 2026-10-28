"""Read/change only this process's inherited Windows console input mode."""
import argparse
import ctypes
from ctypes import wintypes
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument('-Mouse', action='store_true')
    modes.add_argument('-QuickEdit', action='store_true')
    modes.add_argument('-Restore', type=lambda value: int(value, 16))
    args = parser.parse_args()
    if sys.platform != 'win32':
        parser.error('Windows console required')

    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.GetStdHandle.argtypes = [wintypes.DWORD]
    kernel.GetStdHandle.restype = wintypes.HANDLE
    kernel.GetConsoleMode.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
    kernel.GetConsoleMode.restype = wintypes.BOOL
    kernel.SetConsoleMode.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    kernel.SetConsoleMode.restype = wintypes.BOOL
    handle = kernel.GetStdHandle(-10)
    mode = wintypes.DWORD()
    if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
        print('unknown')
        return 1
    before = mode.value
    if args.Mouse:
        new = (before | 0x80 | 0x10 | 0x200) & ~0x40
    elif args.QuickEdit:
        new = (before | 0x80 | 0x40) & ~0x10
    else:
        new = args.Restore
    if new is not None:
        if not kernel.SetConsoleMode(handle, new):
            print(f'error: SetConsoleMode failed ({ctypes.get_last_error()})')
            return 1
        if not kernel.GetConsoleMode(handle, ctypes.byref(mode)):
            print('error: GetConsoleMode failed')
            return 1
    print(f'0x{mode.value:X} vt={int(bool(mode.value & 0x200))} '
          f'quickedit={int(bool(mode.value & 0x40))} was=0x{before:X}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
