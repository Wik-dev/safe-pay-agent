import "@stdlib/ownable";

message Release {
    queryId: Int as uint64;
}

message Refund {
    queryId: Int as uint64;
}

struct PaymentDetails {
    recipient: Address;
    condition: String;
    released: Bool;
    balance: Int as coins;
}

contract SafePayment with Ownable {
    owner: Address;
    recipient: Address;
    condition: String;
    released: Bool;

    init(recipient: Address, condition: String) {
        self.owner = sender();
        self.recipient = recipient;
        self.condition = condition;
        self.released = false;
    }

    // Accept deployment + deposits
    receive() {}

    // Accept deposits with comment
    receive("deposit") {}

    // Owner releases funds to recipient
    receive(msg: Release) {
        self.requireOwner();
        require(!self.released, "Already released");
        self.released = true;
        send(SendParameters{
            to: self.recipient,
            value: 0,
            mode: SendRemainingBalance | SendDestroyIfZero,
            body: "Payment released".asComment()
        });
    }

    // Owner refunds back to themselves
    receive(msg: Refund) {
        self.requireOwner();
        require(!self.released, "Already released");
        self.released = true;
        send(SendParameters{
            to: self.owner,
            value: 0,
            mode: SendRemainingBalance | SendDestroyIfZero,
            body: "Payment refunded".asComment()
        });
    }

    get fun balance(): Int {
        return myBalance();
    }

    get fun isReleased(): Bool {
        return self.released;
    }

    get fun details(): PaymentDetails {
        return PaymentDetails{
            recipient: self.recipient,
            condition: self.condition,
            released: self.released,
            balance: myBalance()
        };
    }
}
