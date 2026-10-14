//go:build windows

package httpx

import (
	"syscall"
	"unsafe"
)

var (
	kernel32            = syscall.NewLazyDLL("kernel32.dll")
	getDiskFreeSpaceExW = kernel32.NewProc("GetDiskFreeSpaceExW")
)

func getDiskSpace(path string) (total, free, used uint64) {
	var freeBytesAvailable, totalNumberOfBytes, totalNumberOfFreeBytes uint64
	ptr, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, 0, 0
	}
	r1, _, _ := getDiskFreeSpaceExW.Call(
		uintptr(unsafe.Pointer(ptr)),
		uintptr(unsafe.Pointer(&freeBytesAvailable)),
		uintptr(unsafe.Pointer(&totalNumberOfBytes)),
		uintptr(unsafe.Pointer(&totalNumberOfFreeBytes)),
	)
	if r1 == 0 {
		return 0, 0, 0
	}
	total = totalNumberOfBytes
	free = freeBytesAvailable
	if total >= free {
		used = total - free
	}
	return total, free, used
}
