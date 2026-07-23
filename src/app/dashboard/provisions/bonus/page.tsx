import { Gift } from 'lucide-react';

export default function BonusProvisionPage() {
  return (
    <div className="p-8">
      <div className="flex items-center gap-3 mb-2">
        <Gift className="h-5 w-5 text-muted-foreground" />
        <h1 className="text-2xl font-bold text-foreground">Bonus</h1>
      </div>
      <p className="text-sm text-muted-foreground">This section is coming soon.</p>
    </div>
  );
}
