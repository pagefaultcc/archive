package archiveidx

import (
	"archive/zip"
	"bytes"
	"testing"
)

func TestParseCardFileBytes_KeyValueFormat(t *testing.T) {
	raw := []byte(`
==================================================
Holder: John Doe
Card Number: 4111 2222 3333 4444
Expiration: 12/26
CVV: 123
Brand: Visa
==================================================
Cardholder: Jane Smith
Card: 5500-0000-0000-0004
Exp Month: 05
Exp Year: 2028
CVC: 456
==================================================
`)

	chunks := parseCardFileBytes("CreditCards/Cards.txt", "Cards.txt", raw)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d: %+v", len(chunks), chunks)
	}

	c1 := chunks[0]
	if c1.Holder != "John Doe" || c1.Number != "4111222233334444" || c1.ExpMonth != "12" || c1.ExpYear != "2026" || c1.CVV != "123" || c1.Brand != "Visa" {
		t.Errorf("chunk 1 mismatch: %+v", c1)
	}

	c2 := chunks[1]
	if c2.Holder != "Jane Smith" || c2.Number != "5500000000000004" || c2.ExpMonth != "05" || c2.ExpYear != "2028" || c2.CVV != "456" || c2.Brand != "Mastercard" {
		t.Errorf("chunk 2 mismatch: %+v", c2)
	}
}

func TestParseCardFileBytes_DelimitedFormat(t *testing.T) {
	raw := []byte("4111222233334444|12/26|123|John Doe\n378282246310005|11/25|1234|Alice\n")
	chunks := parseCardFileBytes("Cards.txt", "Cards.txt", raw)
	if len(chunks) != 2 {
		t.Fatalf("expected 2 chunks, got %d", len(chunks))
	}
	if chunks[0].Number != "4111222233334444" || chunks[0].Brand != "Visa" || chunks[0].Holder != "John Doe" {
		t.Errorf("chunk 0 mismatch: %+v", chunks[0])
	}
	if chunks[1].Number != "378282246310005" || chunks[1].Brand != "American Express" || chunks[1].Holder != "Alice" {
		t.Errorf("chunk 1 mismatch: %+v", chunks[1])
	}
}

func TestParseCardFileBytes_JSONFormat(t *testing.T) {
	raw := []byte(`[
		{
			"name": "Bob Vance",
			"number": "6011000000000000",
			"expiration": "08/29",
			"cvv": "999"
		}
	]`)
	chunks := parseCardFileBytes("autofill/cards.json", "cards.json", raw)
	if len(chunks) != 1 {
		t.Fatalf("expected 1 chunk, got %d", len(chunks))
	}
	if chunks[0].Holder != "Bob Vance" || chunks[0].Number != "6011000000000000" || chunks[0].Brand != "Discover" || chunks[0].ExpMonth != "08" || chunks[0].ExpYear != "2029" {
		t.Errorf("chunk mismatch: %+v", chunks[0])
	}
}

func TestDetectCardBrand(t *testing.T) {
	cases := []struct {
		num      string
		expected string
	}{
		{"4111222233334444", "Visa"},
		{"5100000000000000", "Mastercard"},
		{"2221000000000000", "Mastercard"},
		{"378282246310005", "American Express"},
		{"6011000000000000", "Discover"},
		{"3528000000000000", "JCB"},
		{"36000000000000", "Diners Club"},
		{"6200000000000000", "UnionPay"},
		{"2200000000000000", "Mir"},
	}

	for _, tc := range cases {
		b := DetectCardBrand(tc.num)
		if b != tc.expected {
			t.Errorf("num %s expected brand %s, got %s", tc.num, tc.expected, b)
		}
	}
}

func TestExtractCards_ZipFastPath(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	w, err := zw.Create("CreditCards/Cards.txt")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = w.Write([]byte("Card Number: 4111222233334444\nHolder: Test User\nExpiration: 01/30\nCVV: 007\n"))
	_ = zw.Close()

	// Write to temporary zip
	tmpZip := t.TempDir() + "/test_cards.zip"
	if err := os.WriteFile(tmpZip, buf.Bytes(), 0o600); err != nil {
		t.Fatal(err)
	}

	entries := []Entry{
		{Path: "CreditCards/Cards.txt", Name: "Cards.txt", SizeBytes: int64(buf.Len())},
	}

	chunks := ExtractCards(t.Context(), tmpZip, "zip", "", entries)
	if len(chunks) != 1 {
		t.Fatalf("expected 1 card chunk, got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].Number != "4111222233334444" || chunks[0].Holder != "Test User" || chunks[0].Brand != "Visa" {
		t.Errorf("extracted chunk mismatch: %+v", chunks[0])
	}
}
