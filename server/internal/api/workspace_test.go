package api

import "testing"

func TestSameWorkspaceName(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"Shop", "Shop", true},
		{"Shop", "shop", true},
		{" Shop ", "SHOP", true},
		{"Shop", "Shop 2", false},
		{"Shop", "Other", false},
	}
	for _, c := range cases {
		if got := sameWorkspaceName(c.a, c.b); got != c.want {
			t.Errorf("sameWorkspaceName(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}
