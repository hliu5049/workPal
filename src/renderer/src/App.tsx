import { useState } from 'react'
import Layout from './components/Layout'

function App(): JSX.Element {
  return (
    <div className="h-screen w-full bg-background text-foreground overflow-hidden">
       <Layout />
    </div>
  )
}

export default App
