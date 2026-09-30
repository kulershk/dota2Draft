// Package safe contains panic containment for long-lived goroutines: one bad
// GC payload or nil deref in a single bot/lobby goroutine must not take down
// the process and every other bot with it.
package safe

import (
	"log"
	"runtime/debug"
)

// Recover logs and swallows a panic. Use as `defer safe.Recover("where")` at
// the top of a goroutine.
func Recover(where string) {
	if r := recover(); r != nil {
		log.Printf("PANIC in %s: %v\n%s", where, r, debug.Stack())
	}
}
