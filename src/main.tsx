import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import { isSupabaseConfigured } from './lib_supabase'

function App() {
  return (
    <main className="min-h-screen grid place-items-center p-6">
      <div className="max-w-md text-center space-y-3">
        <h1 className="text-3xl font-semibold text-ysc-gold">YOUR SALES CARS</h1>
        <p className="text-zinc-400">Etapa 1 — fundação do banco concluída. Interface em construção.</p>
        {!isSupabaseConfigured && (
          <p className="text-amber-400 text-sm">Supabase não configurado: defina as variáveis do .env (veja .env.example).</p>
        )}
      </div>
    </main>
  )
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>)
