import { Mail } from "lucide-react";
import { Button } from "@/components/ui/button";

type Props = {
  emailV1Enabled: boolean;
};

export function CommunicationsTab({ emailV1Enabled }: Props) {
  if (!emailV1Enabled) {
    return (
      <div className="p-6 text-center text-muted-foreground text-sm border rounded-lg">
        Email, SMS, and call recording coming in Phase 4.
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center justify-center gap-4 p-10 border rounded-lg text-center">
      <Mail className="h-10 w-10 text-muted-foreground/40" />
      <div className="space-y-1">
        <p className="font-medium text-foreground text-sm">No emails yet</p>
        <p className="text-sm text-muted-foreground">
          Connect your inbox to start syncing conversation history
        </p>
      </div>
      <Button disabled variant="outline" size="sm">
        Connect inbox
      </Button>
    </div>
  );
}
