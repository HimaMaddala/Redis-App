import express from 'express';
import { redis, supabase } from './db.js';
import cors from 'cors';

const app = express();
app.use(express.json());
app.use(cors()); // Allows your Angular frontend to talk to this API

const CART_KEY = 'cart:user_1';

// 1. GET PRODUCTS (Cache-Aside Pattern)
app.get('/products', async (req, res) => {
    const MENU_KEY = 'menu:all';
    const cachedMenu = await redis.get(MENU_KEY);

    if (cachedMenu) {
        console.log('--- Cache Hit ---');
        return res.json(cachedMenu);
    }

    console.log('--- Cache Miss ---');
    const { data: products, error } = await supabase.from('products').select('*');
    if (error) return res.status(500).json(error);

    await redis.set(MENU_KEY, JSON.stringify(products), { ex: 3600 });
    res.json(products);
});

// 2. UPDATE CART (Atomic Increments)
app.post('/cart/update', async (req, res) => {
    const { productId, quantityChange } = req.body;
    
    // 1. Update the quantity
    const newQty = await redis.hincrby(CART_KEY, productId, quantityChange);

    // 2. Set/Refresh expiration to 1 hour (3600 seconds)
    await redis.expire(CART_KEY, 3600); 

    // 3. Clean up if necessary
    if (newQty <= 0) {
        await redis.hdel(CART_KEY, productId);
    }
    
    res.json({ success: true, currentQuantity: newQty });
});

// 3. VIEW CART
app.get('/cart', async (req, res) => {
    const cartData = await redis.hgetall(CART_KEY);
    res.json(cartData || {});
});

// 4. CHECKOUT (The "Final Move")
app.post('/checkout', async (req, res) => {
    try {
        const cart = await redis.hgetall(CART_KEY);
        if (!cart || Object.keys(cart).length === 0) {
            return res.status(400).json({ error: "Cart is empty" });
        }

        // Fetch prices from DB (don't trust Redis for prices)
        const { data: products } = await supabase.from('products').select('*');
        
        let total = 0;
        const lineItems = [];

        for (const [id, qty] of Object.entries(cart)) {
            const product = products.find(p => p.id == id);
            if (product) {
                const quantity = parseInt(qty);
                total += product.price * quantity;
                lineItems.push({ product_id: id, quantity, unit_price: product.price });
            }
        }

        // Insert Order into Supabase
        const { data: order, error: orderErr } = await supabase
            .from('orders')
            .insert([{ total_amount: total }])
            .select().single();

        if (orderErr) throw orderErr;

        // Insert Order Items
        const itemsWithId = lineItems.map(item => ({ ...item, order_id: order.id }));
        await supabase.from('order_items').insert(itemsWithId);

        // CLEAR REDIS
        await redis.del(CART_KEY);

        res.json({ success: true, orderId: order.id, total });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 5. VIEW ORDERS (Direct DB Read)
app.get('/orders', async (req, res) => {
    // We go straight to Supabase for permanent records
    const { data: orders, error } = await supabase
        .from('orders')
        .select(`
            *,
            order_items (
                quantity,
                unit_price,
                products (name)
            )
        `)
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json(error);
    res.json(orders);
});
// 6. DELETE ITEM (Remove specific product from cart)
app.delete('/cart/item/:productId', async (req, res) => {
    const { productId } = req.params;
    
    // HDEL removes the field from the hash entirely
    await redis.hdel(CART_KEY, productId);
    
    res.json({ success: true, message: `Product ${productId} removed from cart` });
});

// 7. CLEAR ENTIRE CART (User wants to start over)
app.delete('/cart/clear', async (req, res) => {
    // DEL deletes the entire key
    await redis.del(CART_KEY);
    res.json({ success: true, message: "Cart cleared" });
});

// 8. SET EXACT QUANTITY (User types '5' in an input box)
app.put('/cart/set', async (req, res) => {
    const { productId, quantity } = req.body;

    if (quantity <= 0) {
        await redis.hdel(CART_KEY, productId);
        return res.json({ success: true, currentQuantity: 0 });
    }

    // HSET sets the value regardless of what was there before
    await redis.hset(CART_KEY, { [productId]: quantity });
    await redis.expire(CART_KEY, 3600); // Reset 1-hour timer

    res.json({ success: true, currentQuantity: quantity });
});

app.listen(3000, () => console.log('Server running on port 3000'));