// =============================================================================
// A refusal must say which refusal it is
// =============================================================================
// `RecordPaymentForm` replaced EVERY 400 with "Amount exceeds the allowed
// limit." The API distinguishes them, and they are fixed in entirely different
// ways — two are not about the amount at all, so the sentence was simply false.
// Measured against the live API on the demo school:
//
//   "Invoice is cancelled"                       -> "Amount exceeds the allowed limit."
//   "Invoice is already paid"                    -> "Amount exceeds the allowed limit."
//   "Issue the invoice before recording payment"  (same)
//   "Refund exceeds the amount paid 5000000"      (same)
//   "Payment exceeds the outstanding balance 0. 10000000 is already awaiting
//    approval on this invoice."                   (same)
//
// The last one exists precisely so a bursar knows WHY they are blocked — the
// overpayment guard now counts money awaiting approval — and this line threw it
// away at the final hop.
// =============================================================================

import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ refresh: jest.fn() }) }));

import { RecordPaymentForm } from "../../components/fees/RecordPaymentForm";

function answer(status: number, message: string) {
  global.fetch = jest.fn(async () => ({
    ok: status < 300,
    status,
    text: async () => JSON.stringify({ message, statusCode: status }),
    json: async () => ({ message, statusCode: status }),
  })) as unknown as typeof fetch;
}

async function submit(amount = "100") {
  const box = screen.getByLabelText(/amount/i);
  fireEvent.change(box, { target: { value: amount } });
  fireEvent.click(screen.getByRole("button", { name: /record|save|submit/i }));
}

describe("recording a payment that is refused", () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([
    ["Invoice is cancelled"],
    ["Invoice is already paid"],
    ["Issue the invoice before recording payment"],
    ["Payment exceeds the outstanding balance 0. 10000000 is already awaiting approval on this invoice."],
  ])("shows the server's own reason: %s", async (message) => {
    answer(400, message);
    render(<RecordPaymentForm invoiceId="inv-1" balanceMinor={10_000_000} currency="NGN" />);
    await submit();
    await waitFor(() => expect(screen.getByText(new RegExp(message.slice(0, 24), "i"))).toBeInTheDocument());
  });

  it("never replaces a refusal with a claim about the AMOUNT", async () => {
    // "Invoice is cancelled" has nothing to do with how much was typed, and a
    // message that says otherwise sends a bursar to change a number that was
    // never the problem.
    answer(400, "Invoice is cancelled");
    render(<RecordPaymentForm invoiceId="inv-1" balanceMinor={10_000_000} currency="NGN" />);
    await submit();
    await waitFor(() => expect(screen.getByText(/cancelled/i)).toBeInTheDocument());
    expect(screen.queryByText(/exceeds the allowed limit/i)).toBeNull();
  });
});
