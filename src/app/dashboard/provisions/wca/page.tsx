import { ShieldCheck } from 'lucide-react';

export default function WcaProvisionPage() {
  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-2">
        <ShieldCheck className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold text-foreground">WCA</h1>
      </div>
      <p className="text-sm text-muted-foreground">This section is coming soon.</p>
    </div>
  );
}
