package safe

import "testing"

func TestRecoverSwallowsPanic(t *testing.T) {
	func() {
		defer Recover("test")
		panic("boom")
	}()
	// reaching here means the panic was contained
}
