import { useState, useEffect } from 'react';
import { Activity, Play, Plus, RefreshCw, UploadCloud, Video, Music, Image as ImageIcon, Send, Clock, CheckCircle, XCircle, AlertCircle } from 'lucide-react';

type Job = {
  id: string;
  asset_id: string;
  status: string;
  caption: string | null;
  result_url: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
};

export default function App() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [assetIdInput, setAssetIdInput] = useState('');
  const [dryRun, setDryRun] = useState(true);
  const [vertical, setVertical] = useState(true);

  const fetchJobs = async () => {
    try {
      const res = await fetch('/api/jobs');
      const data = await res.json();
      if (Array.isArray(data)) setJobs(data);
    } catch (e) {
      console.error('Failed to load jobs', e);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 2500); // Poll for state changes
    return () => clearInterval(interval);
  }, []);

  const triggerJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assetIdInput) return;
    setLoading(true);
    try {
      await fetch('/api/trigger', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ assetId: assetIdInput, dryRun, vertical })
      });
      setAssetIdInput('');
      fetchJobs();
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed': return <CheckCircle className="w-4 h-4 text-emerald-400" />;
      case 'dry_run_complete': return <CheckCircle className="w-4 h-4 text-amber-400" />;
      case 'error': return <XCircle className="w-4 h-4 text-rose-400" />;
      case 'pending': return <Clock className="w-4 h-4 text-slate-400" />;
      default: return <RefreshCw className="w-4 h-4 text-cyan-400 animate-spin" />;
    }
  };

  return (
    <div className="min-h-screen bg-[#0f172a] text-slate-100 font-sans relative overflow-hidden flex">
      {/* Animated-like Mesh Gradient Background */}
      <div className="fixed inset-0 z-0 pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[50%] h-[50%] rounded-full bg-blue-600/30 blur-[120px]"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[50%] h-[50%] rounded-full bg-purple-600/30 blur-[120px]"></div>
        <div className="absolute top-[20%] right-[10%] w-[30%] h-[30%] rounded-full bg-cyan-500/20 blur-[100px]"></div>
      </div>

      <div className="relative z-10 w-full max-w-7xl mx-auto my-6 flex flex-col p-6 md:p-10 gap-8 bg-white/5 backdrop-blur-sm rounded-[2rem] shadow-2xl">
        
        {/* Header */}
        <header className="flex items-center justify-between bg-white/10 backdrop-blur-xl border border-white/10 rounded-3xl p-6">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 bg-gradient-to-br from-cyan-400 to-blue-600 rounded-xl flex items-center justify-center shadow-lg">
              <Activity className="w-6 h-6 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-white">
                DockTok
              </h1>
              <p className="text-xs font-medium text-slate-400 uppercase tracking-widest mt-1">Orchestrator Node</p>
            </div>
          </div>
          
          <button 
            onClick={fetchJobs}
            className="px-4 py-2 bg-white/10 hover:bg-white/20 rounded-xl text-sm transition-all border border-white/10 text-white flex gap-2 items-center"
          >
            <RefreshCw className="w-4 h-4 text-cyan-400" />
            Refresh
          </button>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          
          {/* Main Action Panel - Frosted Glass */}
          <section className="lg:col-span-1 space-y-6">
            <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-[2rem] p-6 relative overflow-hidden">
              <div className="absolute inset-0 bg-gradient-to-br from-white/5 to-transparent pointer-events-none" />
              
              <h2 className="text-lg font-semibold text-white/90 mb-6 flex items-center gap-2">
                <Play className="w-5 h-5 text-cyan-400" />
                Initiate Pipeline
              </h2>
              
              <form onSubmit={triggerJob} className="space-y-4 relative z-10">
                <div>
                  <label className="block text-sm font-medium text-slate-400 mb-1.5">Asset ID (Cloudflare R2)</label>
                  <input
                    type="text"
                    value={assetIdInput}
                    onChange={(e) => setAssetIdInput(e.target.value)}
                    placeholder="e.g. raw_clip_8472.mp4"
                    className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-cyan-500/50 backdrop-blur-sm transition-all"
                  />
                </div>
                
                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={vertical}
                    onChange={(e) => setVertical(e.target.checked)}
                    className="w-4 h-4 rounded accent-cyan-500"
                  />
                  <span>Vertical 9:16 <span className="text-slate-500">(Reel / TikTok format)</span></span>
                </label>

                <label className="flex items-center gap-2 text-sm text-slate-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                    className="w-4 h-4 rounded accent-cyan-500"
                  />
                  <span>Dry run <span className="text-slate-500">(process &amp; preview, skip publishing)</span></span>
                </label>

                <button
                  type="submit"
                  disabled={loading || !assetIdInput}
                  className="w-full py-3 px-4 bg-white/10 hover:bg-white/20 text-white rounded-xl font-medium border border-white/10 transition-all disabled:opacity-50 flex items-center justify-center gap-2"
                >
                  {loading ? <RefreshCw className="w-5 h-5 animate-spin text-cyan-400" /> : <UploadCloud className="w-5 h-5 text-cyan-400" />}
                  <span>{loading ? 'Triggering...' : 'Start Orchestration'}</span>
                </button>
              </form>
            </div>

            {/* Architecture Overview */}
            <div className="bg-white/5 backdrop-blur-md border border-white/10 rounded-[2rem] p-6">
              <p className="text-xs text-slate-400 uppercase tracking-widest mb-4">Pipeline Steps</p>
              <ul className="space-y-4">
                <li className="flex items-center gap-3 text-slate-200">
                  <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center"><UploadCloud className="w-4 h-4 text-orange-400" /></div>
                  <span className="text-sm">Pull from Cloudflare R2</span>
                </li>
                <li className="flex items-center gap-3 text-slate-200">
                  <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center"><Video className="w-4 h-4 text-emerald-400" /></div>
                  <span className="text-sm">FFmpeg Mux & Fingerprint</span>
                </li>
                <li className="flex items-center gap-3 text-slate-200">
                  <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center"><Activity className="w-4 h-4 text-cyan-400" /></div>
                  <span className="text-sm">OpenAI Dynamic Captions</span>
                </li>
                <li className="flex items-center gap-3 text-slate-200">
                  <div className="w-8 h-8 rounded-full bg-white/5 border border-white/10 flex items-center justify-center"><Send className="w-4 h-4 text-pink-400" /></div>
                  <span className="text-sm">Zernio API Publish</span>
                </li>
              </ul>
            </div>
          </section>

          {/* Job Feed - Frosted Glass */}
          <section className="lg:col-span-2">
            <div className="h-full bg-white/5 backdrop-blur-md border border-white/10 rounded-[2rem] p-6 flex flex-col overflow-hidden shadow-2xl">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-semibold text-white">Active Queue</h2>
                <span className="text-xs text-slate-400 uppercase tracking-widest">Real-time status</span>
              </div>
              
              <div className="flex-1 overflow-y-auto custom-scrollbar -mx-2 px-2">
                {jobs.length === 0 ? (
                  <div className="h-48 flex flex-col items-center justify-center text-slate-500 bg-white/5 rounded-2xl border border-white/5">
                    <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
                    <p>No orchestration jobs found.</p>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {jobs.map(job => (
                      <div key={job.id} className="bg-white/5 p-4 rounded-2xl border border-white/5 flex flex-col gap-3 group transition-colors hover:bg-white/10">
                        <div className="flex items-start justify-between">
                          <div className="flex gap-4 items-center">
                            <div className="w-12 h-12 rounded-lg bg-slate-800 flex-shrink-0 flex items-center justify-center text-xs font-mono border border-white/10 text-cyan-300 break-all p-1 text-center leading-tight shadow-inner">
                              {job.asset_id.substring(0, 5)}
                            </div>
                            <div className="flex flex-col">
                               <div className="flex items-center gap-2 mb-1 text-sm font-medium text-slate-100">
                                 <span>{job.asset_id}</span>
                                 <span className="text-xs font-normal text-slate-500">
                                   {new Date(job.created_at).toLocaleTimeString()}
                                 </span>
                               </div>
                               <p className="text-xs text-slate-500 font-mono w-48 truncate group-hover:w-auto transition-all">ID: {job.id}</p>
                            </div>
                          </div>
                          
                          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-white/5 border border-white/10 backdrop-blur-md shadow-sm">
                            {getStatusIcon(job.status)}
                            <span className="text-xs font-semibold uppercase tracking-widest text-slate-300">
                              {job.status.replace('_', ' ')}
                            </span>
                          </div>
                        </div>

                        {job.caption && (
                          <div className="mt-1 p-3 rounded-xl bg-white/5 border border-white/5">
                            <p className="text-sm text-slate-300"><span className="text-slate-500 font-mono text-xs uppercase tracking-widest mr-2">Caption:</span> {job.caption}</p>
                          </div>
                        )}

                        {job.result_url && (
                          <a
                            href={job.result_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="mt-1 p-3 rounded-xl bg-cyan-500/10 border border-cyan-500/20 flex items-center gap-2 hover:bg-cyan-500/20 transition-colors"
                          >
                            <Video className="w-4 h-4 text-cyan-300 flex-shrink-0" />
                            <span className="text-sm text-cyan-200 truncate">Processed video</span>
                          </a>
                        )}
                        
                        {job.error_message && (
                          <div className="mt-1 p-3 rounded-xl bg-rose-500/10 border border-rose-500/20">
                            <p className="text-sm text-rose-300"><span className="font-semibold text-rose-500 mr-2">Error:</span> {job.error_message}</p>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </section>

        </div>
      </div>
      
      {/* Scrollbar styling for pure visual polish */}
      <style>{`
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.02);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}</style>
    </div>
  );
}
