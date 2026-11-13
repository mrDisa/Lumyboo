// Worker entry point reserved for the River-backed synchronization/notification stages.
// Do not run an idle process that falsely reports that jobs are being processed.
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "Worker is not implemented yet. River jobs follow authentication and agreed product rules; see README.md.")
	os.Exit(1)
}
